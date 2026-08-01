#!/usr/bin/env node

import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import ChildProcess from 'node:child_process';
import Net from 'node:net';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayUrl = 'http://localhost:8787';
const workerUrl = 'http://127.0.0.1:8789';
const debugUrl = `${gatewayUrl}/debug_iframe_dev_formula`;
const consumerUrl = 'ws://localhost:8787';
const waitTimeoutMs = 30_000;
const pollIntervalMs = 250;
const expectedResult = 17;

const children = new Set();
let browserProcess;
let browserProfileDirectory;

function log(message) {
	console.log(`[real dev_formula] ${message}`);
}

function command(commandName, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = ChildProcess.spawn(commandName, args, {
			cwd: repositoryDirectory,
			stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
			detached: true,
			env: { ...process.env, ...options.env },
		});
		children.add(child);
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk) => { stdout += chunk; });
		child.stderr?.on('data', (chunk) => { stderr += chunk; });
		child.once('error', (error) => {
			children.delete(child);
			reject(error);
		});
		child.once('exit', (code, signal) => {
			children.delete(child);
			resolve({ child, code, signal, stdout, stderr });
		});
	});
}

function start(commandName, args) {
	const child = ChildProcess.spawn(commandName, args, {
		cwd: repositoryDirectory,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true,
		env: process.env,
	});
	children.add(child);
	child.stdout?.on('data', (chunk) => process.stdout.write(`[${commandName}] ${chunk}`));
	child.stderr?.on('data', (chunk) => process.stderr.write(`[${commandName}] ${chunk}`));
	child.once('exit', (code, signal) => {
		children.delete(child);
		if (code !== 0 && signal === null) console.error(`[real dev_formula] ${commandName} exited with code ${code}`);
	});
	return child;
}

function stop(child) {
	if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch (error) {
		if (error.code !== 'ESRCH') throw error;
	}
}

function closeDebugPage() {
	if (process.platform !== 'darwin') return;
	const script = `tell application "Google Chrome"
repeat with currentWindow in windows
repeat with currentTab in tabs of currentWindow
if URL of currentTab starts with "${debugUrl}" then close currentTab
end repeat
end repeat
end tell`;
	ChildProcess.spawnSync('osascript', ['-e', script], { stdio: 'ignore' });
}

async function waitFor(description, predicate) {
	const deadline = Date.now() + waitTimeoutMs;
	let lastValue;
	while (Date.now() < deadline) {
		lastValue = await predicate();
		if (lastValue !== false) return lastValue;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	throw new Error(`Timed out waiting for ${description}${lastValue === undefined ? '' : `; last value: ${JSON.stringify(lastValue)}`}`);
}

async function httpReady(url) {
	try {
		const response = await fetch(url);
		return response.ok;
	} catch {
		return false;
	}
}

async function assertPortAvailable(port) {
	const occupied = await new Promise((resolve) => {
		const socket = Net.createConnection({ host: '127.0.0.1', port });
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => resolve(false));
	});
	if (occupied) throw new Error(`Port ${port} is already in use; stop the existing process before running the real test`);
}

function parseJsonObjects(output) {
	const objects = [];
	let start;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < output.length; index += 1) {
		const character = output[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === '{') {
			if (depth === 0) start = index;
			depth += 1;
		} else if (character === '}') {
			depth -= 1;
			if (depth === 0 && start !== undefined) {
				try { objects.push(JSON.parse(output.slice(start, index + 1))); } catch { /* Ignore non-JSON output. */ }
				start = undefined;
			}
		}
	}
	return objects;
}

async function workerStatus() {
	const result = await command('node', ['--import', 'tsx', 'packages/consumer_cli/src/cli.ts', '--url', consumerUrl, 'status', '--json']);
	if (result.code !== 0) return false;
	return parseJsonObjects(result.stdout).at(-1) ?? false;
}

async function runTask() {
	const result = await command('node', [
		'--import', 'tsx', 'packages/consumer_cli/src/cli.ts', '--url', consumerUrl,
		'submit', '--type', 'dev_formula', '--name', 'real-dev-formula-test', '5',
	]);
	if (result.code !== 0) throw new Error(`Consumer CLI failed with exit code ${result.code}: ${result.stderr}`);
	const completed = parseJsonObjects(result.stdout).find((task) => task.state === 'completed');
	if (completed === undefined) throw new Error(`Consumer CLI did not report completion:\n${result.stdout}`);
	if (completed.result !== expectedResult) throw new Error(`Expected result ${expectedResult}, received ${completed.result}`);
	return completed;
}

async function main() {
	log('building protocol package');
	const build = await command('npm', ['run', 'build', '--workspace', '@webai/protocol']);
	if (build.code !== 0) throw new Error(`Protocol build failed:\n${build.stderr}`);

	log('starting Gateway and worker website');
	await assertPortAvailable(8787);
	await assertPortAvailable(8789);
	const gateway = start('node', ['--import', 'tsx', 'packages/gateway/src/cli.ts', '--port', '8787']);
	const worker = start('npm', ['run', 'dev', '--workspace', '@webai/worker-webpage', '--', '--host', '127.0.0.1', '--port', '8789']);
	await waitFor('Gateway health endpoint', () => httpReady(`${gatewayUrl}/health`));
	await waitFor('worker website', () => httpReady(workerUrl));

	browserProfileDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'webai-real-test-'));
	log(`opening ${debugUrl} in a dedicated headed Chrome process`);
	browserProcess = start('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
		`--user-data-dir=${browserProfileDirectory}`,
		'--no-first-run', '--no-default-browser-check', '--disable-default-apps', debugUrl,
	]);

	const connected = await waitFor('two connected browser workers', async () => {
		const status = await workerStatus();
		return status !== false && status.workerCount === 2 ? status : false;
	});
	log(`workers connected: ${connected.workers.map((worker) => worker.name).join(', ')}`);

	const completed = await runTask();
	log(`PASS: dev_formula completed with result ${completed.result}`);

	log('closing dedicated Chrome process');
	closeDebugPage();
	stop(browserProcess);
	browserProcess = undefined;
	const clean = await waitFor('all browser workers to leave', async () => {
		const status = await workerStatus();
		return status !== false && status.workerCount === 0 ? status : false;
	});
	log(`clean cluster verified: ${clean.workerCount} workers, ${clean.activeAssignments} active assignments`);
}

try {
	await main();
} catch (error) {
	console.error(`[real dev_formula] FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	closeDebugPage();
	stop(browserProcess);
	for (const child of children) stop(child);
	if (browserProfileDirectory !== undefined) Fs.rmSync(browserProfileDirectory, { recursive: true, force: true });
}
