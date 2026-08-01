// node imports
import type Http from 'node:http';
import Path from 'node:path';

// npm imports
import Express from 'express';
import { MessageLogger } from '@webai/protocol/message_logger';

// local imports
import { ClusterTaskRunner } from './libs/cluster_task_runner.js';
import { CurlStyleTransactionLogger } from './libs/curl_style_transaction_logger.js';
import { OpenaiRoutes } from './libs/openai_routes.js';
import { ServerSettings } from './libs/server_settings.js';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — serves the OpenAI completion interface in front of the Web AI at Home cluster
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds every part of this server and starts serving.
 *
 * Each part is constructed here and handed only the parts it actually needs, so what depends
 * on what is visible in one place, as it is in the central gateway's own command line program.
 */
export class Cli {
	/**
	 * The running HTTP server, closed on shutdown.
	 *
	 * Express opens it, rather than this file building one with `Http.createServer` and handing
	 * the requests to Express, which is what [issue #70](https://github.com/webai-at-home/webai-at-home/issues/70)
	 * asks of every web-serving package. `Http` is therefore imported for its type only.
	 */
	private static httpServer: Http.Server | undefined;
	/** The connection to the central gateway, closed on shutdown. */
	private static runner: ClusterTaskRunner | undefined;

	/** Builds the server and starts listening. */
	static run(): void {
		const settings = new ServerSettings();

		// This server's own message traffic with the central gateway, one file per run, the way
		// the consumer command line program records it.
		const logsDirectory = Path.join(__dirname, '../logs');
		const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const messageLogger = new MessageLogger(
			Path.join(logsDirectory, `consumer-openai-${runTimestamp}.log_entry.jsonl`),
		);

		// Every `POST /v1/chat/completions` transaction this server answers, kept in its own file
		// and its own shape rather than folded into the message log above: that file is this
		// server's wire protocol with the central gateway, and this one is what a caller of this
		// server experienced, which are easier to read apart than interleaved.
		// `metadata.gatewayRequestId` on an entry here joins it back to the matching
		// `task.submit` in the other file.
		const transactionLogger = new CurlStyleTransactionLogger(
			Path.join(logsDirectory, `consumer_openai-${runTimestamp}.log_http.txt`),
		);

		const runner = new ClusterTaskRunner({
			gatewayUrl: settings.gatewayUrl,
			authToken: settings.authToken,
			name: settings.name,
			requestTimeoutMs: settings.requestTimeoutMs,
			connectionWaitMs: settings.connectionWaitMs,
			maximumTasksInFlight: settings.maximumTasksInFlight,
			messageLogger,
		});
		const routes = new OpenaiRoutes(runner, settings.apiKey, Math.floor(Date.now() / 1000), transactionLogger);

		const app = Express();
		app.disable('x-powered-by');
		app.use(routes.router());

		const httpServer = app.listen(settings.port, () => {
			console.log(`The OpenAI-compatible server is listening on http://localhost:${settings.port}`);
			console.log(
				`Point an OpenAI client at http://localhost:${settings.port}/v1 and submit tasks to the central ` +
					`gateway at ${settings.gatewayUrl}`,
			);
			if (settings.apiKey === undefined) {
				console.log('No key is required from a caller, because this server was started without --api-key');
			}
		});

		Cli.httpServer = httpServer;
		Cli.runner = runner;

		process.on('SIGINT', () => Cli._shutdown());
		process.on('SIGTERM', () => Cli._shutdown());
	}

	/** Gives up on every request still waiting, closes the connection, and stops listening. */
	private static _shutdown(): void {
		Cli.runner?.close();
		Cli.runner = undefined;
		Cli.httpServer?.close();
		Cli.httpServer = undefined;
	}
}

if (process.argv[1] !== undefined && __filename === process.argv[1]) {
	Cli.run();
}
