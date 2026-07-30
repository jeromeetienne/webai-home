import * as Commander from 'commander';
import Url from 'node:url';
import Path from 'node:path';
import WebSocket from 'ws';
import { MessageLogger } from '@webai/protocol/message_logger';
import { ConsumerClient, type TaskSocket } from './libs/consumer_client.js';
import { TaskInputFactory, taskTypeNames } from './libs/task_input_factory.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — submits one task to the central gateway and prints what comes back
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The command line program of the consumer.
 *
 * It reads the task type and its value from the command line, opens one connection to the
 * central gateway, submits a single task, prints every answer as formatted JSON, and closes
 * the connection once the task has either completed or failed.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const command = new Commander.Command()
			.argument('<input>', 'number for dev_formula, free text for either language-model task type')
			.option('-u, --url <url>', 'central gateway WebSocket URL', 'ws://localhost:8787')
			.option('-t, --type <type>', `task type: ${taskTypeNames.join(', ')}`, 'dev_formula')
			.option('-n, --name <name>', 'consumer name', 'consumer')
			.option('-s, --stream', 'ask for the answer in pieces as it is produced, rather than in one result once it is finished');
		command.parse([process.argv[0], process.argv[1] ?? '', ...args]);
		const options = command.opts<{ url: string; type: string; name: string; stream?: boolean }>();
		if (TaskInputFactory.isTaskTypeName(options.type) === false) {
			throw new Error(`Type must be one of ${taskTypeNames.join(', ')}`);
		}
		// Nothing is asked for when the option is absent, so a submission without it carries no
		// generation settings at all rather than a settings field stating the default.
		const generationSettings = options.stream === true ? { isStreaming: true } : undefined;
		const taskInput = TaskInputFactory.createTaskInput(options.type, command.args[0], generationSettings);

		const logsDirectory = Url.fileURLToPath(new URL('../logs', import.meta.url));
		const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const messageLogger = new MessageLogger(Path.join(logsDirectory, `consumer-cli-${runTimestamp}.log_entry.jsonl`));

		// The connection of the `ws` package names its event handlers with its own event
		// types, so it is read here through the smaller shape this client actually uses.
		const socket = new WebSocket(options.url) as unknown as TaskSocket;
		const client = new ConsumerClient(socket, {
			onMessage: (direction, message) => messageLogger.log(direction, { role: 'gateway' }, message.type, message),
			onRegistered: () => client.submit(taskInput),
			onTaskAccepted: (task) => console.log(JSON.stringify(task, null, 2)),
			onTaskUpdated: (update) => {
				console.log(JSON.stringify(update, null, 2));
				if (update.state === 'completed' || update.state === 'failed') client.close();
			},
			onError: (error) => {
				console.error(error.message);
				client.close();
			},
		}, options.name);
	}
}

if (process.argv[1] !== undefined && Url.fileURLToPath(import.meta.url) === process.argv[1]) void Cli.run();
