// node imports
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// npm imports
import { Command } from "commander";
import { WebSocketServer, type WebSocket } from "ws";
import { TaskInput, type ClientMessage, type Device, type ServerMessage, type StageName } from "@webai/protocol";

// local imports
import { DeviceRegistry } from "./libs/device_registry.js";
import { nextStage, TaskStore } from "./libs/task_store.js";

const options = new Command().option("-p, --port <number>", "HTTP and WebSocket port", "8787").parse().opts<{ port: string }>();
const port = Number(options.port);
const registry = new DeviceRegistry();
const tasks = new TaskStore();
const sockets = new Map<string, WebSocket>();

function send(socket: WebSocket, message: ServerMessage): void { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); }
function broadcast(message: ServerMessage): void { for (const socket of sockets.values()) send(socket, message); }
function volunteerDevices(): Device[] { return registry.list().filter((device) => device.role === "volunteer"); }
function updateDevices(): void { broadcast({ type: "devices", devices: volunteerDevices() }); }
function assign(taskId: string, value: number, stage: StageName, excluded: string[] = []): void {
	const device = registry.findVolunteer(stage, excluded) ?? registry.findVolunteer(stage);
	if (!device) { tasks.update(taskId, { state: "failed", error: `No volunteer is available for ${stage}` }); broadcastTask(taskId); return; }
	tasks.update(taskId, { state: "assigned" });
	const socket = sockets.get(device.deviceId);
	if (socket) send(socket, { type: "stage.assign", taskId, stage, value });
	broadcastTask(taskId);
}
function broadcastTask(taskId: string): void { const task = tasks.get(taskId); if (task) broadcast({ type: "task.updated", task }); }
function handle(socket: WebSocket, deviceId: string, message: ClientMessage): void {
	if (message.type === "register") {
		const existingDevice = message.role === "volunteer" ? registry.findByName(message.name, "volunteer") : undefined;
		if (existingDevice && existingDevice.deviceId !== deviceId) {
			registry.remove(existingDevice.deviceId);
			const existingSocket = sockets.get(existingDevice.deviceId);
			sockets.delete(existingDevice.deviceId);
			existingSocket?.close(1000, "Replaced by a newer connection with the same volunteer name");
		}
		const device: Device = { deviceId, name: message.name, role: message.role, capabilities: message.role === "volunteer" ? (message.capabilities ?? ["cap_formula_multiply", "cap_formula_add"]) : [], connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
		registry.add(device); send(socket, { type: "registered", deviceId }); updateDevices(); return;
	}
	if (message.type === "task.submit") {
		const parsed = TaskInput.safeParse(message.input); if (!parsed.success) return send(socket, { type: "error", message: "Input must be a finite number" }); const task = tasks.create(parsed.data); send(socket, { type: "task.accepted", task }); assign(task.taskId, task.input.input * 1, "multiply"); return;
	}
	if (message.type === "task.get") { const task = tasks.get(message.taskId); if (task) send(socket, { type: "task.updated", task }); else send(socket, { type: "error", message: "Task was not found" }); return; }
	if (message.type === "stage.result") {
		const device = registry.get(deviceId);
		if (!device || device.role !== "volunteer") return send(socket, { type: "error", message: "Only volunteer browser tabs may return stage results" });
		const task = tasks.get(message.taskId);
		if (!task || nextStage(task) !== message.stage) return send(socket, { type: "error", message: "Unexpected stage result" });
		const updated = tasks.addStage(task.taskId, { name: message.stage, value: message.value });
		const upcoming = nextStage(updated);
		if (upcoming) assign(updated.taskId, message.value, upcoming, [deviceId]);
		else {
			tasks.update(updated.taskId, { state: "completed", result: message.value });
			broadcastTask(updated.taskId);
		}
		return;
	}
	if (message.type === "stage.failed") {
		const device = registry.get(deviceId);
		if (!device || device.role !== "volunteer") return send(socket, { type: "error", message: "Only volunteer browser tabs may fail a stage" });
		tasks.update(message.taskId, { state: "failed", error: message.error }); broadcastTask(message.taskId); return;
	}
	if (message.type === "signal") { const target = sockets.get(message.to); if (target) send(target, { type: "signal", from: deviceId, data: message.data }); }
}

const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), "../public");
const pages = {
	admin: readFileSync(join(publicDirectory, "admin/index.html")),
	volunteer: readFileSync(join(publicDirectory, "volunteer/index.html")),
	debugIframe: readFileSync(join(publicDirectory, "debug_iframe/index.html")),
};
const assets = new Map([
	["/admin/src/main.ts", { content: readFileSync(join(publicDirectory, "admin/src/main.ts")), type: "application/javascript; charset=utf-8" }],
	["/volunteer/src/main.ts", { content: readFileSync(join(publicDirectory, "volunteer/src/main.ts")), type: "application/javascript; charset=utf-8" }],
	["/admin/css/main.css", { content: readFileSync(join(publicDirectory, "admin/css/main.css")), type: "text/css; charset=utf-8" }],
	["/volunteer/css/main.css", { content: readFileSync(join(publicDirectory, "volunteer/css/main.css")), type: "text/css; charset=utf-8" }],
	["/debug_iframe/css/main.css", { content: readFileSync(join(publicDirectory, "debug_iframe/css/main.css")), type: "text/css; charset=utf-8" }],
]);
const httpServer = createServer((request, response) => {
	const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
	if (pathname === "/" || pathname === "/admin") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(pages.admin); return; }
	if (pathname === "/volunteer") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(pages.volunteer); return; }
	if (pathname === "/debug_iframe") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(pages.debugIframe); return; }
	const asset = assets.get(pathname);
	if (asset) { response.setHeader("content-type", asset.type); response.end(asset.content); return; }
	response.setHeader("content-type", "application/json");
	if (pathname === "/health") { response.end(JSON.stringify({ ok: true, devices: volunteerDevices().length })); return; }
	response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" }));
});
const websocketServer = new WebSocketServer({ server: httpServer });
websocketServer.on("connection", (socket) => { const deviceId = `device-${crypto.randomUUID()}`; sockets.set(deviceId, socket); socket.on("message", (raw) => { try { handle(socket, deviceId, JSON.parse(raw.toString()) as ClientMessage); } catch { send(socket, { type: "error", message: "Invalid message" }); } }); socket.on("close", () => { sockets.delete(deviceId); registry.remove(deviceId); updateDevices(); }); });
httpServer.listen(port, () => console.log(`Central server listening on http://localhost:${port}`));
