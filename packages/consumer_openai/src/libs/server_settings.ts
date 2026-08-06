import { Command } from 'commander';
import Path from 'node:path';
import Url from 'node:url';
import { AccountKeyFile } from '@webai/protocol/account_key_file';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ServerSettings — this server's command line options, read once and typed
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Where this server defaults to reading its configuration directory, which holds its own account key
 * pair in `default.account_key.json`.
 *
 * This is `consumer_openai`'s own identity for this checkout of the repository, kept separate from
 * `consumer_cli`'s in `data/consumer_cli_config/` and `worker_openai`'s in
 * `data/worker_openai_config/`, so every task this server submits lands on one consistent account
 * without `--config_dir` being passed by hand.
 *
 * Resolved from this file's own location rather than written as a bare
 * `data/consumer_openai_config` string, because a relative path resolves against the process's
 * working directory, not this file's — and `npm run dev --workspace @webai/consumer-openai --` and
 * `npx tsx src/cli.ts` both run with the working directory somewhere other than the repository root.
 */
const defaultConfigDir = Path.resolve(Path.dirname(Url.fileURLToPath(import.meta.url)), '../../../../data/consumer_openai_config');

/** The command line options exactly as they arrive, before they are converted. */
type RawOptions = {
	port: string;
	gatewayUrl: string;
	authToken: string;
	apiKey?: string;
	consumer_name: string;
	config_dir: string;
	requestTimeoutMs: string;
	connectionWaitMs: string;
	maxTasksInFlight: string;
};

/**
 * Reads this server's command line options and presents them as the values the rest of the
 * server uses.
 *
 * Every option arrives as text and is converted in one place here, so that no other part of
 * the server repeats the conversion or has to remember which options are numbers. This
 * follows `GatewaySettings` in `packages/gateway/src/libs/gateway_settings.ts`.
 */
export class ServerSettings {
	/** The port this server listens on for OpenAI-compatible requests. */
	readonly port: number;
	/** The WebSocket address of the central gateway to submit tasks to. */
	readonly gatewayUrl: string;
	/** The bearer token the central gateway requires from this server. */
	readonly authToken: string;
	/** The key a request must present to this server. Absent means no key is required. */
	readonly apiKey: string | undefined;
	/** The consumer name this server registers under with the central gateway. */
	readonly name: string;
	/**
	 * Where this server's own account key pair is kept, as `default.account_key.json` inside the
	 * configuration directory.
	 *
	 * One deployment of this server is one account. A directory with no key pair in it means this
	 * server runs with no account, and the stages its tasks run are recorded against the shared
	 * development account.
	 */
	readonly accountKeyFile: string;
	/** How long one task may run before it is cancelled and the request is given up on. */
	readonly requestTimeoutMs: number;
	/** How long a request waits for a registered gateway connection before it is refused. */
	readonly connectionWaitMs: number;
	/** How many cluster tasks this server will have in flight at once. */
	readonly maximumTasksInFlight: number;

	/**
	 * @param argv The command line arguments. Defaults to this process's own.
	 */
	constructor(argv?: string[]) {
		const command = new Command()
			.option('-p, --port <number>', 'Port to serve OpenAI-compatible requests on', '8788')
			.option('-u, --gateway-url <url>', 'Central gateway WebSocket URL', 'ws://localhost:8787')
			.option('-t, --auth-token <token>', 'Bearer token the central gateway requires', 'development-token')
			.option('-k, --api-key <key>', 'Key a request must present to this server. Omit to require none')
			.option('-n, --consumer_name <name>', 'Consumer name to register under with the central gateway', 'consumer_openai server')
			.option('-c, --config_dir <path>', 'The directory holding this server\'s own account key pair, as default.account_key.json, so the stages its tasks run are recorded against that account. A directory with no key pair in it means no account', defaultConfigDir)
			.option('--request-timeout-ms <number>', 'How long one task may run before it is cancelled', '600000')
			.option(
				'--connection-wait-ms <number>',
				'How long a request waits for a registered gateway connection before it is refused',
				'5000',
			)
			// The central gateway's own --max-tasks-per-principal defaults to 20, and it refuses a
			// submission beyond that, so this server holds no more than that in flight either and
			// answers the caller itself rather than passing on a refusal it could have foreseen.
			.option('--max-tasks-in-flight <number>', 'How many cluster tasks to have in flight at once', '20');
		const options = (
			argv === undefined
				? command.parse()
				: command.parse(argv, {
						from: 'user',
					})
		).opts<RawOptions>();

		this.port = Number(options.port);
		this.gatewayUrl = options.gatewayUrl;
		this.authToken = options.authToken;
		this.apiKey = options.apiKey;
		this.name = options.consumer_name;
		this.accountKeyFile = AccountKeyFile.pathInConfigDir(options.config_dir);
		this.requestTimeoutMs = Number(options.requestTimeoutMs);
		this.connectionWaitMs = Number(options.connectionWaitMs);
		this.maximumTasksInFlight = Number(options.maxTasksInFlight);
	}
}
