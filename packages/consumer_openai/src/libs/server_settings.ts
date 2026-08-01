import { Command } from 'commander';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ServerSettings — this server's command line options, read once and typed
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The command line options exactly as they arrive, before they are converted. */
type RawOptions = {
	port: string;
	gatewayUrl: string;
	authToken: string;
	apiKey?: string;
	name: string;
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
			.option('-n, --name <name>', 'Consumer name to register under with the central gateway', 'consumer_openai server')
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
		this.name = options.name;
		this.requestTimeoutMs = Number(options.requestTimeoutMs);
		this.connectionWaitMs = Number(options.connectionWaitMs);
		this.maximumTasksInFlight = Number(options.maxTasksInFlight);
	}
}
