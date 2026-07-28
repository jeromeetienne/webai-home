import * as Commander from "commander";
import NodeUrl from "node:url";
import NodePath from "node:path";
import WebSocket from "ws";
import { MessageLogger } from "@webai/protocol/message_logger";
import { createTaskInput, ConsumerClient } from "./consumer_client.js";

export class MainHelper {
	static parseInputFormula(value: string | undefined): number { return createTaskInput("formula", value).input as number; }
	static parseInputLLM(value: string | undefined): string { return createTaskInput("llm", value).input as string; }

	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const command = new Commander.Command()
			.argument("<input>", "number for formula, free text for llm")
			.option("-u, --url <url>", "central gateway WebSocket URL", "ws://localhost:8787")
			.option("-t, --type <type>", "task type: formula or llm", "formula");
		command.parse([process.argv[0], process.argv[1] ?? "", ...args]);
		const options = command.opts<{ url: string; type: string }>();
		if (options.type !== "formula" && options.type !== "llm") throw new Error('Type must be either "formula" or "llm"');
		const taskInput = createTaskInput(options.type, command.args[0]);
		const logsDirectory = NodeUrl.fileURLToPath(new URL("../logs", import.meta.url));
		const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const messageLogger = new MessageLogger(NodePath.join(logsDirectory, `consumer-${runTimestamp}.jsonl`));
		const socket = new WebSocket(options.url) as unknown as ConstructorParameters<typeof ConsumerClient>[0];
		const client = new ConsumerClient(socket, {
			onMessage: (direction, message) => messageLogger.log(direction, { role: "gateway" }, message.type, message),
			onRegistered: () => client.submit(taskInput),
			onTaskAccepted: (task) => console.log(JSON.stringify(task, null, 2)),
			onTaskUpdated: (task) => {
				console.log(JSON.stringify(task, null, 2));
				if (task.state === "completed" || task.state === "failed") client.close();
			},
			onError: (message) => { console.error(message); client.close(); },
		});
	}
}

if (process.argv[1] && NodeUrl.fileURLToPath(import.meta.url) === process.argv[1]) void MainHelper.run();
