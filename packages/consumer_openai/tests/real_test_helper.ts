import ChildProcess from 'node:child_process';
import Net from 'node:net';
import Path from 'node:path';

import Puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	RealTestHelper — starts and stops the real gateway/worker/browser cluster real tests need
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The worker cluster fields this helper reads out of `consumer_cli status --json`. */
type WorkerStatusSnapshot = {
	/** How many workers the cluster currently has. */
	workerCount: number;
	/** How many of those workers report themselves ready. */
	readyCount: number;
};

/** The exit code and output collected from running one command to completion. */
type CompletionResult = {
	/** The process's exit code, or `null` if it was killed by a signal. */
	code: number | null;
	/** Everything the process wrote to standard output. */
	stdout: string;
	/** Everything the process wrote to standard error. */
	stderr: string;
};

const __dirname = import.meta.dirname;

const repositoryDirectory = Path.resolve(__dirname, '../../..');

/**
 * Starts the central gateway, the worker web page, the OpenAI-compatible server, and a headless Chrome
 * browser with two ready `dev_formula` workers, then tears them all down again.
 */
export class RealTestHelper {
	/** The base URL the central gateway answers HTTP requests on. */
	readonly gatewayUrl = 'http://localhost:8787';
	/** The base URL the worker web page answers on. */
	readonly workerUrl = 'http://127.0.0.1:8789';
	/** The base URL this package's own OpenAI-compatible server answers on. */
	readonly openaiUrl = 'http://localhost:8788';
	/** The gateway's debug page that sets up the two `dev_formula` worker browser tabs. */
	readonly debugUrl = `${this.gatewayUrl}/debug_iframe_dev_formula`;

	/** How long `_waitFor` polls before giving up. */
	private readonly waitTimeoutMs = 30_000;
	/** How long `_waitFor` sleeps between polling attempts. */
	private readonly pollIntervalMs = 250;

	/** Every long-running process this helper has started and not yet stopped. */
	private readonly children = new Set<ChildProcess.ChildProcess>();
	/** The Chrome browser Puppeteer launched, once `setup` has started it. */
	private browser: Browser | undefined;
	/** Whether `setup` launches Chrome headless (`true`) or as a visible window (`false`). */
	private readonly headless: boolean;
	/** How many milliseconds Puppeteer delays each browser operation by, to make a run easier to watch. */
	private readonly slowMoMs: number;
	/** The signal handler `setup` registers so a Ctrl-C still tears down the started processes and browser. */
	private readonly signalHandler: () => void;

	/** Whether `teardown` has already run, so the signal handler does not run it a second time. */
	private tornDown = false;

	/**
	 * @param options - construction options
	 * @param options.headless - whether `setup` launches Chrome headless (`true`, the default) or as a visible
	 * window (`false`), useful for watching a test run locally
	 * @param options.slowMoMs - how many milliseconds Puppeteer delays each browser operation by (`0` by default),
	 * useful for slowing a visible run down to something a person can follow
	 */
	constructor(options: { headless?: boolean; slowMoMs?: number } = {}) {
		this.headless = options.headless ?? true;
		this.slowMoMs = options.slowMoMs ?? 0;
		this.signalHandler = () => {
			this.teardown().finally(() => process.exit(1));
		};
	}

	/**
	 * Builds the protocol and consumer CLI packages, starts the gateway/worker-page/OpenAI-compatible
	 * servers and a headless browser, then waits for two ready `dev_formula` workers.
	 */
	async setup(): Promise<void> {
		process.on('SIGINT', this.signalHandler);
		process.on('SIGTERM', this.signalHandler);

		await this._assertPortAvailable(8787);
		await this._assertPortAvailable(8788);
		await this._assertPortAvailable(8789);

		const build = await this._runToCompletion('npm', [
			'run', 'build',
			'--workspace', '@webai/protocol',
			'--workspace', '@webai/consumer-cli',
		]);
		if (build.code !== 0) {
			throw new Error(`Building @webai/protocol and @webai/consumer-cli failed:\n${build.stderr}`);
		}

		this._start('node', ['--import', 'tsx', 'packages/gateway/src/cli.ts']);
		this._start('npm', [
			'run', 'dev',
			'--workspace', '@webai/worker-webpage',
			'--', '--host', '127.0.0.1', '--port', '8789',
		]);
		this._start('node', ['--import', 'tsx', 'packages/consumer_openai/src/cli.ts']);
		await this._waitFor('the central gateway to answer', () => this._httpReady(`${this.gatewayUrl}/health`));
		await this._waitFor('the worker web page to answer', () => this._httpReady(this.workerUrl));
		await this._waitFor('the OpenAI-compatible server to answer', () => this._httpReady(`${this.openaiUrl}/health`));

		this.browser = await Puppeteer.launch({
			headless: this.headless,
			slowMo: this.slowMoMs,
			defaultViewport: null,
			args: ['--window-size=800,600'],
		});
		const page = await this.browser.newPage();
		await page.goto(this.debugUrl);

		await this._waitFor('two ready dev_formula workers', async () => {
			const status = await this._workerStatus();
			return status !== false && status.workerCount === 2 && status.readyCount === 2 ? status : false;
		});

		// wait 10 seconds
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}

	/** Stops every process this helper started and closes the Puppeteer browser. */
	async teardown(): Promise<void> {
		if (this.tornDown) {
			return;
		}
		this.tornDown = true;
		process.off('SIGINT', this.signalHandler);
		process.off('SIGTERM', this.signalHandler);

		for (const childProcess of this.children) {
			this._stop(childProcess);
		}
		await this.browser?.close();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one command to completion and reports its exit code and output.
	 * @param commandName - the executable to run
	 * @param args - the arguments to pass to the executable
	 * @returns the exit code, stdout, and stderr collected while the command ran
	 */
	private _runToCompletion(commandName: string, args: string[]): Promise<CompletionResult> {
		return new Promise((resolve, reject) => {
			const childProcess = ChildProcess.spawn(commandName, args, {
				cwd: repositoryDirectory,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			childProcess.stdout?.on('data', (chunk: Buffer) => { stdout += chunk; });
			childProcess.stderr?.on('data', (chunk: Buffer) => { stderr += chunk; });
			childProcess.once('error', reject);
			childProcess.once('exit', (code) => resolve({
				code,
				stdout,
				stderr,
			}));
		});
	}

	/**
	 * Starts a long-running process (a server or the browser), left running until `_stop` is called.
	 * @param commandName - the executable to run
	 * @param args - the arguments to pass to the executable
	 * @returns the started child process
	 */
	private _start(commandName: string, args: string[]): ChildProcess.ChildProcess {
		const childProcess = ChildProcess.spawn(commandName, args, {
			cwd: repositoryDirectory,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		});
		this.children.add(childProcess);
		childProcess.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[${commandName}] ${chunk}`));
		childProcess.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${commandName}] ${chunk}`));
		childProcess.once('exit', () => this.children.delete(childProcess));
		return childProcess;
	}

	/**
	 * Stops one process this helper started, by sending SIGTERM to its whole process group.
	 * @param childProcess - the process to stop, or `undefined` if none was started
	 */
	private _stop(childProcess: ChildProcess.ChildProcess | undefined): void {
		if (
			childProcess === undefined
			|| childProcess.pid === undefined
			|| childProcess.exitCode !== null
			|| childProcess.signalCode !== null
		) {
			return;
		}
		try {
			process.kill(-childProcess.pid, 'SIGTERM');
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
				throw error;
			}
		}
	}

	/**
	 * Polls `predicate` until it returns something other than `false`, or throws once `waitTimeoutMs` passes.
	 * @param description - what is being waited for, used in the timeout error message
	 * @param predicate - the check to poll; returns `false` while not yet satisfied, or the resolved value once it is
	 * @returns the value `predicate` resolved to once it stopped returning `false`
	 */
	private async _waitFor<T>(description: string, predicate: () => Promise<T | false>): Promise<T> {
		const deadline = Date.now() + this.waitTimeoutMs;
		let lastValue: T | false = false;
		while (Date.now() < deadline) {
			lastValue = await predicate();
			if (lastValue !== false) {
				return lastValue;
			}
			await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
		}
		throw new Error(`Timed out waiting for ${description}`);
	}

	/**
	 * Reports whether an HTTP server is answering at `url`.
	 * @param url - the URL to probe
	 * @returns `true` if the server answered with an ok response, `false` otherwise
	 */
	private async _httpReady(url: string): Promise<boolean> {
		try {
			const response = await fetch(url);
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Throws if something is already listening on `port`, so this helper fails fast instead of talking to a stray process.
	 * @param port - the port to check
	 */
	private async _assertPortAvailable(port: number): Promise<void> {
		const occupied = await new Promise<boolean>((resolve) => {
			const socket = Net.createConnection({
				host: '127.0.0.1',
				port,
			});
			socket.once('connect', () => { socket.destroy(); resolve(true); });
			socket.once('error', () => resolve(false));
		});
		if (occupied) {
			throw new Error(`Port ${port} is already in use; stop the existing process before running this test`);
		}
	}

	/**
	 * Reads the worker cluster state from `consumer_cli status`, the same probe README.md's real test used.
	 * @returns the worker cluster snapshot, or `false` if the status command failed
	 */
	private async _workerStatus(): Promise<WorkerStatusSnapshot | false> {
		const result = await this._runToCompletion('node', [
			'--import', 'tsx', 'packages/consumer_cli/src/cli.ts',
			'--url', 'ws://localhost:8787',
			'status', '--json',
		]);
		if (result.code !== 0) {
			return false;
		}
		return JSON.parse(result.stdout) as WorkerStatusSnapshot;
	}
}
