#!/usr/bin/env node
import * as Commander from 'commander';
import Fs from 'node:fs';
import Path from 'node:path';
import { TaskInputFactory, taskTypeNames } from './libs/task_input_factory.js';
import { CliError } from './libs/cli_errors.js';
import { SubmitCommand } from './commands/submit_command.js';
import { StatusCommand, statusFormats } from './commands/status_command.js';
import { CapacityCommand, capacityFormats } from './commands/capacity_command.js';
import { LogStatsCommand } from './commands/log_stats_command.js';
import { LogStatisticsFormatter, logStatisticsFormats } from './message_log/log_statistics_formatter.js';
import { AccountOutputFormatter, accountOutputFormats } from './account/account_output_format.js';
import { AccountKeyCommand } from './commands/account_key_command.js';
import { IdentityRegisterCommand } from './commands/identity_register_command.js';
import { AccountInformationCommand } from './commands/account_information_command.js';
import { AccountBalanceCommand } from './commands/account_balance_command.js';
import { AccountHistoryCommand, accountHistoryDirections } from './commands/account_history_command.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the consumer command line program: submit, status, capacity, log_stats, and the account commands
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

/** The default bearer token, matching the gateway's own `--auth-token` default. */
const DEFAULT_AUTHENTICATION_TOKEN = 'development-token';

/**
 * Where every account command defaults to keeping or reading the account key pair.
 *
 * This is `consumer_cli`'s own identity for this checkout of the repository, kept separate from
 * `consumer_openai`'s in `data/consumer_openai_config/` and `worker_openai_api`'s in
 * `data/worker_openai_api_config/`, so every `consumer_cli` command run here uses one consistent
 * account without `--key_file` being passed by hand.
 *
 * Resolved from this file's own location rather than written as a bare `data/consumer_cli_config/…`
 * string, because a relative path resolves against the process's working directory, not this file's —
 * and `npm run dev --workspace @webai/consumer-cli --` and `npx tsx src/cli.ts` both run with the
 * working directory somewhere other than the repository root.
 */
const DEFAULT_ACCOUNT_KEY_FILE_PATH = Path.resolve(__dirname, '../../../data/consumer_cli_config/default.account_key.json');

/** The shared options every subcommand accepts, before each subcommand's own options. */
type GlobalOptions = {
	/** The WebSocket URL of the central gateway every connecting subcommand talks to. */
	url: string;
	/** The bearer token to authenticate with, when the `-a/--auth-token` option was given. */
	authToken?: string;
};

/**
 * The command line program of the consumer: `submit` sends one task to the central gateway,
 * `status` reports the current worker cluster state, `capacity` estimates how many concurrent
 * runs of a task type the cluster can currently support, and `log_stats` measures one already
 * recorded message log file without connecting to anything.
 *
 * Five further commands read and write this participant's own account, which is what the accounting
 * system of issue #122 records contributed and consumed computation against: `account_key`
 * generates the key pair that is the account, `identity_register` tells the central gateway about it,
 * and `account_information`, `account_balance`, and `account_history` read back what the gateway
 * holds for it.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 * @returns A promise that settles once the requested subcommand has finished.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Commander.Command('consumer_cli')
			.option('-u, --url <url>', 'central gateway WebSocket URL', 'ws://localhost:8787')
			.option(
				'-a, --auth-token <token>',
				'bearer token for the central gateway (falls back to the WEBAI_AUTH_TOKEN'
					+ ' environment variable, then to a development default)',
			);

		program
			.command('submit')
			.argument('<input>', 'number for dev_formula, free text for every language-model task type')
			.option('-t, --task_type <type>', `task type: ${taskTypeNames.join(', ')}`, 'dev_formula')
			.option('-n, --consumer_name <name>', 'consumer name', 'consumer')
			.option(
				'-s, --stream',
				'ask for the answer in pieces as it is produced, rather than in one result once'
					+ ' it is finished',
			)
			.option(
				'-k, --key_file <path>',
				'where this participant\'s account key pair is kept, so the stages this task runs'
					+ ' are recorded against that account. A machine with no key pair there'
					+ ' submits with no account',
				DEFAULT_ACCOUNT_KEY_FILE_PATH,
			)
			.action(async (
				input: string,
				localOptions: {
					task_type: string;
					consumer_name: string;
					stream?: boolean;
					key_file: string;
				},
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (TaskInputFactory.isTaskTypeName(options.task_type) === false) {
					throw new Error(`Type must be one of ${taskTypeNames.join(', ')}`);
				}
				await SubmitCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					type: options.task_type,
					name: options.consumer_name,
					stream: options.stream === true,
					keyFilePath: options.key_file,
					input,
				});
			});

		program
			.command('status')
			.description(
				'print the worker cluster state: how many worker browsers are connected, how much'
					+ ' of their capacity is free, and one row per worker',
			)
			.option(
				'--watch',
				'after the first snapshot, stay connected and print a new snapshot every time the'
					+ ' worker cluster changes, until you interrupt with Ctrl-C or the connection'
					+ ' drops (default: print one snapshot and exit)',
			)
			.option('-f, --format <format>', `output format: ${statusFormats.join(', ')}`, 'text')
			.option(
				'--timeout <ms>',
				'milliseconds to wait for the central gateway to accept the connection and send'
					+ ' the first snapshot before giving up',
				'10000',
			)
			.action(async (
				localOptions: { watch?: boolean; format: string; timeout: string },
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (StatusCommand.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${statusFormats.join(', ')}`);
				}
				await StatusCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					watch: options.watch === true,
					format: options.format,
				});
			});

		program
			.command('capacity')
			.requiredOption('--task_type <type>', `task type: ${taskTypeNames.join(', ')}`)
			.option('-f, --format <format>', `output format: ${capacityFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: { task_type: string; format: string; timeout: string },
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (CapacityCommand.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${capacityFormats.join(', ')}`);
				}
				await CapacityCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					type: options.task_type,
					format: options.format,
				});
			});

		program
			.command('log_stats')
			.description(
				'measure one .log_entry.jsonl message log file and print what it says: how much'
					+ ' traffic it carried, who carried it, how long every answer took, what'
					+ ' became of every task and every stage run, and anything worth a second look',
			)
			.argument('<file>', 'path of the .log_entry.jsonl file to measure')
			.option('-f, --format <format>', `output format: ${logStatisticsFormats.join(', ')}`, 'text')
			.option(
				'--top <count>',
				'how many rows of each table to print before the rest are only counted',
				'12',
			)
			.action(async (
				file: string,
				localOptions: { format: string; top: string },
			): Promise<void> => {
				if (LogStatisticsFormatter.isFormat(localOptions.format) === false) {
					throw new Error(`Format must be one of ${logStatisticsFormats.join(', ')}`);
				}
				const top = Number(localOptions.top);
				if (Number.isInteger(top) === false || top < 1) {
					throw new Error('Top must be a whole number of at least 1');
				}
				await LogStatsCommand.run({
					filePath: file,
					format: localOptions.format,
					top,
				});
			});

		program
			.command('account_key')
			.description(
				'generate the key pair that is this participant\'s account, and print the account'
					+ ' identifier it produces. It talks to nothing: the identifier is a digest of'
					+ ' the public key, so it exists as soon as the key pair does',
			)
			.option('-k, --key_file <path>', 'where to keep the key pair', DEFAULT_ACCOUNT_KEY_FILE_PATH)
			.option(
				'--force',
				'overwrite a key pair that is already there, losing the account it belongs to',
			)
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.action(async (
				localOptions: { key_file: string; force?: boolean; format: string },
			): Promise<void> => {
				if (AccountOutputFormatter.isFormat(localOptions.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				await AccountKeyCommand.run({
					keyFilePath: localOptions.key_file,
					isForced: localOptions.force === true,
					format: localOptions.format,
				});
			});

		program
			.command('identity_register')
			.description(
				'tell the central gateway about this machine\'s public key, so completed and'
					+ ' consumed stages can be recorded against the account it identifies',
			)
			.option('-k, --key_file <path>', 'where the key pair is kept', DEFAULT_ACCOUNT_KEY_FILE_PATH)
			.option('--email_address <address>', 'the email address for the account profile', '')
			.option('--display_name <name>', 'the display name for the account profile', '')
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: {
					key_file: string;
					email_address: string;
					display_name: string;
					format: string;
					timeout: string;
				},
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (AccountOutputFormatter.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				await IdentityRegisterCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					keyFilePath: options.key_file,
					emailAddress: options.email_address,
					displayName: options.display_name,
					format: options.format,
				});
			});

		program
			.command('account_information')
			.description(
				'print the profile the central gateway holds for this account: its identifier,'
					+ ' its public key, its display name, its email address, and when it was'
					+ ' registered',
			)
			.option('-k, --key_file <path>', 'where the key pair is kept', DEFAULT_ACCOUNT_KEY_FILE_PATH)
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: { key_file: string; format: string; timeout: string },
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (AccountOutputFormatter.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				await AccountInformationCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					keyFilePath: options.key_file,
					format: options.format,
				});
			});

		program
			.command('account_balance')
			.description(
				'print what this account holds: one credit for every stage it completed as a'
					+ ' worker, less one for every stage it had run as a consumer',
			)
			.option('-k, --key_file <path>', 'where the key pair is kept', DEFAULT_ACCOUNT_KEY_FILE_PATH)
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: { key_file: string; format: string; timeout: string },
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (AccountOutputFormatter.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				await AccountBalanceCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					keyFilePath: options.key_file,
					format: options.format,
				});
			});

		program
			.command('account_history')
			.description(
				'print this account\'s accounting entries, newest first. --direction earned lists'
					+ ' the stages this account completed, and --direction spent lists the stages'
					+ ' it had run',
			)
			.option('-k, --key_file <path>', 'where the key pair is kept', DEFAULT_ACCOUNT_KEY_FILE_PATH)
			.option(
				'-d, --direction <direction>',
				`which side of the ledger to print: ${accountHistoryDirections.join(', ')}`,
				'both',
			)
			.option('-l, --limit <count>', 'how many entries to ask for at a time', '20')
			.option('--all', 'keep asking for further pages until the whole history has been printed')
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: {
					key_file: string;
					direction: string;
					limit: string;
					all?: boolean;
					format: string;
					timeout: string;
				},
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (AccountOutputFormatter.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				if (AccountHistoryCommand.isDirection(options.direction) === false) {
					throw new Error(`Direction must be one of ${accountHistoryDirections.join(', ')}`);
				}
				const limit = Number(options.limit);
				if (Number.isInteger(limit) === false || limit < 1) {
					throw new Error('Limit must be a whole number of at least 1');
				}
				await AccountHistoryCommand.run({
					url: options.url,
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					keyFilePath: options.key_file,
					direction: options.direction,
					limit,
					isEverythingRequested: options.all === true,
					format: options.format,
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
	 * `__filename` is Node's already-resolved real path. Comparing both sides after
	 * resolving symlinks handles that invocation the same as running this file directly.
	 *
	 * @returns `true` when this process was started to run this file.
	 */
	static isMainModule(): boolean {
		if (process.argv[1] === undefined) {
			return false;
		}
		try {
			return __filename === Fs.realpathSync(process.argv[1]);
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
		return optionValue ?? process.env.WEBAI_AUTH_TOKEN ?? DEFAULT_AUTHENTICATION_TOKEN;
	}
}

if (Cli.isMainModule()) {
	void Cli.run();
}
