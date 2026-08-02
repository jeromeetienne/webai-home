#!/usr/bin/env node
import * as Commander from 'commander';
import Fs from 'node:fs';
import Url from 'node:url';
import { TaskInputFactory, taskTypeNames } from './libs/task_input_factory.js';
import { CliError } from './libs/cli_errors.js';
import { SubmitCommand } from './commands/submit_command.js';
import { StatusCommand } from './commands/status_command.js';
import { CapacityCommand } from './commands/capacity_command.js';
import { LogStatsCommand } from './commands/log_stats_command.js';
import { LogStatisticsFormatter, logStatisticsFormats } from './message_log/log_statistics_formatter.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the consumer command line program: submit, status, capacity, and log_stats
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The default bearer token, matching the gateway's own `--auth-token` default. */
const defaultAuthenticationToken = 'development-token';

/** The shared options every subcommand accepts, before each subcommand's own options. */
type GlobalOptions = { url: string; authToken?: string };

/**
 * The command line program of the consumer: `submit` sends one task to the central gateway,
 * `status` reports the current worker cluster state, `capacity` estimates how many concurrent
 * runs of a task type the cluster can currently support, and `log_stats` measures one already
 * recorded message log file without connecting to anything.
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
			.option('-t, --task_type <type>', `task type: ${taskTypeNames.join(', ')}`, 'dev_formula')
			.option('-n, --consumer_name <name>', 'consumer name', 'consumer')
			.option('-s, --stream', 'ask for the answer in pieces as it is produced, rather than in one result once it is finished')
			.action(async (input: string, localOptions: { task_type: string; consumer_name: string; stream?: boolean }, command: Commander.Command) => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (TaskInputFactory.isTaskTypeName(options.task_type) === false) throw new Error(`Type must be one of ${taskTypeNames.join(', ')}`);
				await SubmitCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					type: options.task_type,
					name: options.consumer_name,
					stream: options.stream === true,
					input,
				});
			});

		program
			.command('status')
			.description('print the worker cluster state: how many worker browsers are connected, how much of their capacity is free, and one row per worker')
			.option('--watch', 'after the first snapshot, stay connected and print a new snapshot every time the worker cluster changes, until you interrupt with Ctrl-C or the connection drops (default: print one snapshot and exit)')
			.option('--json', 'print each snapshot as a JSON object instead of the human-readable table')
			.option('--timeout <ms>', 'milliseconds to wait for the central gateway to accept the connection and send the first snapshot before giving up', '10000')
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
			.requiredOption('--task_type <type>', `task type: ${taskTypeNames.join(', ')}`)
			.option('--json', 'print the estimate as JSON instead of a sentence')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (localOptions: { task_type: string; json?: boolean; timeout: string }, command: Commander.Command) => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				await CapacityCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					type: options.task_type,
					json: options.json === true,
				});
			});

		program
			.command('log_stats')
			.description('measure one .log_entry.jsonl message log file and print what it says: how much traffic it carried, who carried it, how long every answer took, what became of every task and every stage run, and anything worth a second look')
			.argument('<file>', 'path of the .log_entry.jsonl file to measure')
			.option('-f, --format <format>', `output format: ${logStatisticsFormats.join(', ')}`, 'text')
			.option('--top <count>', 'how many rows of each table to print before the rest are only counted', '12')
			.action(async (file: string, localOptions: { format: string; top: string }): Promise<void> => {
				if (LogStatisticsFormatter.isFormat(localOptions.format) === false) throw new Error(`Format must be one of ${logStatisticsFormats.join(', ')}`);
				const top = Number(localOptions.top);
				if (Number.isInteger(top) === false || top < 1) throw new Error('Top must be a whole number of at least 1');
				await LogStatsCommand.run({
					filePath: file,
					format: localOptions.format,
					top,
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
