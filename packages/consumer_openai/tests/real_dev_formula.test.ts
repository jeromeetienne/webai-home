import Assert from 'node:assert/strict';
import ChildProcess from 'node:child_process';
import Fs from 'node:fs';
import Net from 'node:net';
import Os from 'node:os';
import Path from 'node:path';
import NodeTest from 'node:test';
import Url from 'node:url';
import OpenAI from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Real dev_formula test — the OpenAI-compatible server against a real browser worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run test:real --workspace @webai/consumer-openai
//
// Unlike tests/index.test.ts, this test is not part of the default `npm run test
// --workspaces`. It builds the protocol and consumer CLI packages, starts the central gateway,
// the worker web page, and this package's own OpenAI-compatible server, opens the gateway's
// `/debug_iframe_dev_formula` page in a dedicated headless Chrome process to set up the two
// worker browser tabs `dev_formula` needs, then submits `5` through the `openai` package and
// checks the answer comes back as `17`. It needs macOS with Google Chrome installed, the same
// as README.md asks of the whole repository's real browser tests.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Setup
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The worker cluster fields this test reads out of `consumer_cli status --json`. */
type WorkerStatusSnapshot = {
	workerCount: number;
	readyCount: number;
};

const repositoryDirectory = Path.resolve(Path.dirname(Url.fileURLToPath(import.meta.url)), '../../..');
const gatewayUrl = 'http://localhost:8787';
const workerUrl = 'http://127.0.0.1:8789';
const openaiUrl = 'http://localhost:8788';
const debugUrl = `${gatewayUrl}/debug_iframe_dev_formula`;
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const waitTimeoutMs = 30_000;
const pollIntervalMs = 250;
const expectedResult = '17';

const children = new Set<ChildProcess.ChildProcess>();
let browserProcess: ChildProcess.ChildProcess | undefined;
let browserProfileDirectory: string | undefined;

/** Runs one command to completion and reports its exit code and output. */
function runToCompletion(commandName: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = ChildProcess.spawn(commandName, args, { cwd: repositoryDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk; });
		child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk; });
		child.once('error', reject);
		child.once('exit', (code) => resolve({ code, stdout, stderr }));
	});
}

/** Starts a long-running process (a server or the browser), left running until `stop` is called. */
function start(commandName: string, args: string[]): ChildProcess.ChildProcess {
	const child = ChildProcess.spawn(commandName, args, { cwd: repositoryDirectory, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
	children.add(child);
	child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[${commandName}] ${chunk}`));
	child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${commandName}] ${chunk}`));
	child.once('exit', () => children.delete(child));
	return child;
}

/** Stops one process this test started, by sending SIGTERM to its whole process group. */
function stop(child: ChildProcess.ChildProcess | undefined): void {
	if (child === undefined || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
	}
}

/** Resolves once `child` has exited, or immediately if it already has, so cleanup does not race a process still shutting down. */
function waitForExit(child: ChildProcess.ChildProcess | undefined, timeoutMs = 5_000): Promise<void> {
	if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		child.once('exit', () => { clearTimeout(timer); resolve(); });
	});
}

/**
 * Removes the browser's temporary profile directory, retrying briefly on `ENOTEMPTY`: Chrome's
 * helper processes (GPU, network service) can still be releasing files in it for a moment after
 * the main browser process has already exited.
 */
async function removeProfileDirectory(directory: string): Promise<void> {
	const attempts = 10;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			Fs.rmSync(directory, { recursive: true, force: true });
			return;
		} catch (error: unknown) {
			if (attempt === attempts || (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
}

/** Polls `predicate` until it returns something other than `false`, or throws once `waitTimeoutMs` passes. */
async function waitFor<T>(description: string, predicate: () => Promise<T | false>): Promise<T> {
	const deadline = Date.now() + waitTimeoutMs;
	let lastValue: T | false = false;
	while (Date.now() < deadline) {
		lastValue = await predicate();
		if (lastValue !== false) return lastValue;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

/** Reports whether an HTTP server is answering at `url`. */
async function httpReady(url: string): Promise<boolean> {
	try {
		const response = await fetch(url);
		return response.ok;
	} catch {
		return false;
	}
}

/** Throws if something is already listening on `port`, so this test fails fast instead of talking to a stray process. */
async function assertPortAvailable(port: number): Promise<void> {
	const occupied = await new Promise<boolean>((resolve) => {
		const socket = Net.createConnection({ host: '127.0.0.1', port });
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => resolve(false));
	});
	if (occupied) throw new Error(`Port ${port} is already in use; stop the existing process before running this test`);
}

/** Reads the worker cluster state from `consumer_cli status`, the same probe README.md's real test used. */
async function workerStatus(): Promise<WorkerStatusSnapshot | false> {
	const result = await runToCompletion('node', ['--import', 'tsx', 'packages/consumer_cli/src/cli.ts', '--url', 'ws://localhost:8787', 'status', '--json']);
	if (result.code !== 0) return false;
	return JSON.parse(result.stdout) as WorkerStatusSnapshot;
}

NodeTest.before(async () => {
	await assertPortAvailable(8787);
	await assertPortAvailable(8788);
	await assertPortAvailable(8789);

	const build = await runToCompletion('npm', ['run', 'build', '--workspace', '@webai/protocol', '--workspace', '@webai/consumer-cli']);
	if (build.code !== 0) throw new Error(`Building @webai/protocol and @webai/consumer-cli failed:\n${build.stderr}`);

	start('node', ['--import', 'tsx', 'packages/gateway/src/cli.ts']);
	start('npm', ['run', 'dev', '--workspace', '@webai/worker-webpage', '--', '--host', '127.0.0.1', '--port', '8789']);
	start('node', ['--import', 'tsx', 'packages/consumer_openai/src/cli.ts']);
	await waitFor('the central gateway to answer', () => httpReady(`${gatewayUrl}/health`));
	await waitFor('the worker web page to answer', () => httpReady(workerUrl));
	await waitFor('the OpenAI-compatible server to answer', () => httpReady(`${openaiUrl}/health`));

	browserProfileDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'webai-real-test-'));
	browserProcess = start(chromePath, [
		'--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
		`--user-data-dir=${browserProfileDirectory}`,
		debugUrl,
	]);

	await waitFor('two ready dev_formula workers', async () => {
		const status = await workerStatus();
		return status !== false && status.workerCount === 2 && status.readyCount === 2 ? status : false;
	});
}, { timeout: 120_000 });

NodeTest.after(async () => {
	for (const child of children) stop(child);
	await waitForExit(browserProcess);
	if (browserProfileDirectory !== undefined) await removeProfileDirectory(browserProfileDirectory);
}, { timeout: 30_000 });

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Test
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

NodeTest.test('answers 17 for input 5, through a real browser worker cluster and the OpenAI-compatible server', { timeout: 30_000 }, async () => {
	const client = new OpenAI({ baseURL: `${openaiUrl}/v1`, apiKey: 'no-key-required', maxRetries: 0, timeout: 30_000 });
	const completion = await client.chat.completions.create({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }] });
	Assert.equal(completion.choices[0]?.message.content, expectedResult);
});
