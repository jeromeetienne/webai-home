import { Command } from "commander";
import WebSocket from "ws";
import type { ServerMessage } from "@webai/protocol";

const command = new Command().argument("<input>", "number to process").option("-u, --url <url>", "central server WebSocket URL", "ws://localhost:8787");
command.parse();
const options = command.opts<{ url: string }>();
const input = Number(command.args[0]);
if (!Number.isFinite(input)) throw new Error("Input must be a finite number");
const socket = new WebSocket(options.url);
socket.on("open", () => socket.send(JSON.stringify({ type: "register", role: "admin", name: "task-client" })));
socket.on("message", (raw) => { const message = JSON.parse(raw.toString()) as ServerMessage; if (message.type === "registered") socket.send(JSON.stringify({ type: "task.submit", input: { input } })); if (message.type === "task.accepted") console.log(JSON.stringify(message.task, null, 2)); if (message.type === "task.updated") { console.log(JSON.stringify(message.task, null, 2)); if (["completed", "failed"].includes(message.task.state)) socket.close(); } if (message.type === "error") console.error(message.message); });
