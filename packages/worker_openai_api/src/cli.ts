#!/usr/bin/env node
import * as Commander from 'commander';
import WebSocket from 'ws';
import { GatewayWorkerClient, type WorkerSocket } from './libs/gateway_worker_client.js';
import { OpenaiApiClient } from './libs/openai_api_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the native worker command line program: connect, register, run stages
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The default bearer token, matching the gateway's own `--auth-token` default. */
const defaultAuthenticationToken = 'development-token';

/** The options this worker was started with. */
type WorkerOptions = {
	url: string;
	authToken?: string;
	worker_name: string;
	baseUrl: string;
	model: string;
	stageNames?: string[];
};

/**
 * The command line program of the worker that runs a model through a local server speaking the
 * OpenAI-compatible API.
 *
 * It holds one connection to the central gateway for as long as it runs, registering as a
 * worker and running the stages the gateway assigns to it.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Commander.Command('worker_openai_api')
			.description('A worker that runs its assigned stage by calling a local server speaking the OpenAI-compatible Chat Completions API, such as Ollama or LM Studio')
			.option('-u, --url <url>', 'central gateway WebSocket URL', 'ws://localhost:8787')
			.option('-a, --auth-token <token>', 'bearer token for the central gateway (falls back to the WEBAI_AUTH_TOKEN environment variable, then to a development default)')
			.option('-n, --worker_name <name>', 'worker name, which the gateway shows in its device list', 'openai-api-worker')
			.option('-b, --base-url <url>', "base URL of the local server's OpenAI-compatible API", 'http://localhost:1234/v1')
			.option('-m, --model <model>', 'the model the local server is asked for', 'llama-3.2-3b-instruct')
			.option('-s, --stage-names <name...>', 'restrict this worker to these stages, instead of every stage it can run');

		program.parse(args, { from: 'user' });
		const options = program.opts<WorkerOptions>();
		await Cli.connect(options);
	}

	/**
	 * Opens the connection to the central gateway and keeps it until the connection closes.
	 *
	 * @param options The options this worker was started with.
	 * @returns A promise that resolves once the connection has closed.
	 */
	private static connect(options: WorkerOptions): Promise<void> {
		const openaiApiClient = new OpenaiApiClient(options.baseUrl.replace(/\/+$/, ''));
		const socket = new WebSocket(options.url) as unknown as WorkerSocket;
		return new Promise<void>((resolve) => {
			new GatewayWorkerClient(
				socket,
				{
					name: options.worker_name,
					authenticationToken: Cli.resolveAuthToken(options.authToken),
					requestedStageNames: options.stageNames ?? [],
					openaiApiClient,
					modelId: options.model,
				},
				{
					onMessage: (direction, message) => {
						Cli.print(`${direction === 'sent' ? '→' : '←'} ${message.type}`);
					},
					onRegistered: (deviceId, stageNames) => {
						Cli.print(`registered as ${options.worker_name}, device ${deviceId}, offering ${stageNames.join(', ')}`);
					},
					onNotice: (text) => {
						Cli.print(text);
					},
					onFailure: (text) => {
						Cli.print(`failure: ${text}`);
					},
					onConnectionChange: (isConnected) => {
						Cli.print(isConnected ? `connected to ${options.url}` : 'disconnected');
						if (isConnected === false) {
							resolve();
						}
					},
				},
			);
		});
	}

	/**
	 * Chooses the bearer token to present to the central gateway.
	 *
	 * @param fromCommandLine The token given on the command line, if one was given.
	 * @returns The token to present.
	 */
	private static resolveAuthToken(fromCommandLine: string | undefined): string {
		if (fromCommandLine !== undefined && fromCommandLine !== '') {
			return fromCommandLine;
		}
		const fromEnvironment = process.env.WEBAI_AUTH_TOKEN;
		if (fromEnvironment !== undefined && fromEnvironment !== '') {
			return fromEnvironment;
		}
		return defaultAuthenticationToken;
	}

	/**
	 * Writes one line of output, stamped with the time it was written.
	 *
	 * @param text What to write.
	 */
	private static print(text: string): void {
		process.stdout.write(`${new Date().toISOString()} ${text}\n`);
	}
}

await Cli.run();
