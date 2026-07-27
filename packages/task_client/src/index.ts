import * as Commander from "commander";
import NodeUrl from "node:url";
import WebSocket from "ws";
import type { ServerMessage } from "@webai/protocol";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

class MainHelper {
	static parseInput(value: string | undefined): number {
		const input = Number(value);
		if (Number.isFinite(input) === false) {
			throw new Error("Input must be a finite number");
		}
		return input;
	}

	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		// Create a command-line interface using Commander
		const command = new Commander.Command().argument("<input>", "number to process")
			.option("-u, --url <url>", "central server WebSocket URL", "ws://localhost:8787");
		command.parse([process.argv[0], process.argv[1] ?? "", ...args]);

		// Parse the command-line arguments
		const options = command.opts<{ url: string }>();

		// Validate the input argument
		const input = MainHelper.parseInput(command.args[0]);

		// Connect to the central server and submit a task
		const socket = new WebSocket(options.url);
		socket.on("open", () => socket.send(JSON.stringify({ type: "register", role: "admin", name: "task-client" })));
		socket.on("message", (raw) => { const message = JSON.parse(raw.toString()) as ServerMessage; if (message.type === "registered") socket.send(JSON.stringify({ type: "task.submit", input: { input } })); if (message.type === "task.accepted") console.log(JSON.stringify(message.task, null, 2)); if (message.type === "task.updated") { console.log(JSON.stringify(message.task, null, 2)); if (["completed", "failed"].includes(message.task.state)) socket.close(); } if (message.type === "error") console.error(message.message); });
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
