#!/usr/bin/env node
import * as Commander from 'commander';
import Fs from 'node:fs';
import Url from 'node:url';
import { TaskInputFactory, taskTypeNames } from './libs/task_input_factory.js';
import { CliError } from './libs/cli_errors.js';
import { SubmitCommand } from './commands/submit_command.js';
import { StatusCommand } from './commands/status_command.js';
import { CapacityCommand } from './commands/capacity_command.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the consumer command line program: submit, status, and capacity
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The default bearer token, matching the gateway's own `--auth-token` default. */
const defaultAuthenticationToken = 'development-token';

/** The shared options every subcommand accepts, before each subcommand's own options. */
type GlobalOptions = { url: string; authToken?: string };

/**
 * The command line program of the consumer: `submit` sends one task to the central gateway,
 * `status` reports the current worker cluster state, and `capacity` estimates how many
 * concurrent runs of a task type the cluster can currently support.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Commander.Command('consumer_cli')
			.option('-u, --url <url>', 'central gateway WebSocket URL', 'ws://localhost:8787')
			.option('-a, --auth-token <token>', `bearer token for the central gateway (falls back to the ${'WEBAI_AUTH_TOKEN'} environment variable, then to a development default)`);

		program
			.command('submit')
			.argument('<input>', 'number for dev_formula, free text for every language-model task type')
			.option('-t, --type <type>', `task type: ${taskTypeNames.join(', ')}`, 'dev_formula')
			.option('-n, --name <name>', 'consumer name', 'consumer')
			.option('-s, --stream', 'ask for the answer in pieces as it is produced, rather than in one result once it is finished')
			.action(async (input: string, localOptions: { type: string; name: string; stream?: boolean }, command: Commander.Command) => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (TaskInputFactory.isTaskTypeName(options.type) === false) throw new Error(`Type must be one of ${taskTypeNames.join(', ')}`);
				await SubmitCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					type: options.type,
					name: options.name,
					stream: options.stream === true,
					input,
				});
			});

		program
			.command('status')
			.option('-w, --watch', 'keep the connection open and reprint on every change, until interrupted or disconnected')
			.option('--json', 'print the snapshot as JSON instead of a table')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (localOptions: { watch?: boolean; json?: boolean; timeout: string }, command: Commander.Command) => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				await StatusCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					watch: options.watch === true,
					json: options.json === true,
				});
			});

		program
			.command('capacity')
			.argument('<type>', `task type: ${taskTypeNames.join(', ')}`)
			.option('--json', 'print the estimate as JSON instead of a sentence')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (type: string, localOptions: { json?: boolean; timeout: string }, command: Commander.Command) => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				await CapacityCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					type,
					json: options.json === true,
				});
			});

		try {
			await program.parseAsync([process.argv[0] ?? '', process.argv[1] ?? '', ...args]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = error instanceof CliError ? error.exitCode : 1;
		}
	}

	/**
	 * Reports whether this module was started directly, rather than imported.
	 *
	 * `npx`, and the `bin` symlink `npm install` creates for it, invoke this file through a
	 * symlink under `node_modules/.bin`, so `process.argv[1]` is the symlink path while
	 * `import.meta.url` is Node's already-resolved real path. Comparing both sides after
	 * resolving symlinks handles that invocation the same as running this file directly.
	 *
	 * @returns `true` when this process was started to run this file.
	 */
	static isMainModule(): boolean {
		if (process.argv[1] === undefined) return false;
		try {
			return Url.fileURLToPath(import.meta.url) === Fs.realpathSync(process.argv[1]);
		} catch {
			return false;
		}
	}

	/**
	 * Resolves the bearer token to authenticate with, in priority order: the `-a/--auth-token`
	 * option, the `WEBAI_AUTH_TOKEN` environment variable, then the development default.
	 *
	 * @param optionValue The `-a/--auth-token` option, when given.
	 * @returns The bearer token to authenticate with.
	 */
	private static resolveAuthToken(optionValue: string | undefined): string {
		return optionValue ?? process.env.WEBAI_AUTH_TOKEN ?? defaultAuthenticationToken;
	}
}

if (Cli.isMainModule()) void Cli.run();
