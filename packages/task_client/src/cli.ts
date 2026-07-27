import * as Commander from "commander";
import NodeUrl from "node:url";
import WebSocket from "ws";
import type { ServerMessage, TaskType } from "@webai/protocol";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const taskTypeByCliType: Record<"formula" | "llm", TaskType> = {
	formula: "task_type_formula",
	llm: "task_type_llm",
};

export class MainHelper {
	static parseInputFormula(value: string | undefined): number {
		const input = Number(value);
		if (Number.isFinite(input) === false) {
			throw new Error("Input must be a finite number");
		}
		return input;
	}

	static parseInputLLM(value: string | undefined): string {
		if (typeof value !== "string" || value.trim() === "") {
			throw new Error("Input must be a non-empty string");
		}
		return value;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		// Create a command-line interface using Commander
		const command = new Commander.Command().argument("<input>", "value to process — a number for --type formula, free text for --type llm")
			.option("-u, --url <url>", "central server WebSocket URL", "ws://localhost:8787")
			.option("-t, --type <type>", "task type: formula or llm");
		command.parse([process.argv[0], process.argv[1] ?? "", ...args]);

		// Parse the command-line arguments
		const options = command.opts<{ url: string; type: string }>();
		if (options.type !== "formula" && options.type !== "llm") {
			throw new Error("Type must be either \"formula\" or \"llm\"");
		}
		const taskType = taskTypeByCliType[options.type];

		// Parse the input argument according to the task type
		const input = taskType === "task_type_formula" ? MainHelper.parseInputFormula(command.args[0]) : MainHelper.parseInputLLM(command.args[0]);

		// Connect to the central server and submit a task
		const socket = new WebSocket(options.url);
		socket.on("open", () => socket.send(JSON.stringify({ type: "register", role: "admin", name: "task-client" })));
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString()) as ServerMessage;
			if (message.type === "registered") socket.send(JSON.stringify({ type: "task.submit", input: { taskType, input } }));
			if (message.type === "task.accepted") console.log(JSON.stringify(message.task, null, 2));
			if (message.type === "task.updated") {
				console.log(JSON.stringify(message.task, null, 2));
				if (["completed", "failed"].includes(message.task.state)) socket.close();
			}
			if (message.type === "error") {
				console.error(message.message);
				socket.close();
			}
		});
	}

}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

if (process.argv[1] && NodeUrl.fileURLToPath(import.meta.url) === process.argv[1]) {
	void MainHelper.run();
}
