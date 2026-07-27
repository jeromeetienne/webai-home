// node imports
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// npm imports
import { Command } from "commander";
import { WebSocketServer, type WebSocket } from "ws";
import {
	TaskInput,
	type ClientMessage,
	type Device,
	type ServerMessage,
	type StageName,
} from "@webai/protocol";

// local imports
import { DeviceRegistry } from "./libs/device_registry.js";
import { nextStage, TaskStore } from "./libs/task_store.js";

const options = new Command()
	.option("-p, --port <number>", "HTTP and WebSocket port", "8787")
	.parse()
	.opts<{ port: string }>();
const port = Number(options.port);
const registry = new DeviceRegistry();
const tasks = new TaskStore();
const sockets = new Map<string, WebSocket>();

/**
 * Sends a server message when a WebSocket is still open.
 *
 * @param socket - The WebSocket that should receive the message.
 * @param message - The server message to serialize and send.
 */
function send(socket: WebSocket, message: ServerMessage): void {
	if (socket.readyState === socket.OPEN) {
		socket.send(JSON.stringify(message));
	}
}

/**
 * Sends a server message to every connected WebSocket.
 *
 * @param message - The server message to broadcast.
 */
function broadcast(message: ServerMessage): void {
	for (const socket of sockets.values()) {
		send(socket, message);
	}
}

/**
 * Returns the connected devices that can volunteer for task stages.
 *
 * @returns The currently connected volunteer devices.
 */
function volunteerDevices(): Device[] {
	return registry.list().filter((device) => device.role === "volunteer");
}

/**
 * Broadcasts the current volunteer device list to connected clients.
 */
function updateDevices(): void {
	broadcast({
		type: "devices",
		devices: volunteerDevices(),
	});
}

/**
 * Assigns a task stage to an available volunteer device.
 *
 * @param taskId - The task identifier to assign.
 * @param value - The value that the volunteer must process.
 * @param stage - The stage to assign.
 * @param excluded - Device identifiers that must not receive the assignment.
 */
function assign(
	taskId: string,
	value: number,
	stage: StageName,
	excluded: string[] = [],
): void {
	const device = registry.findVolunteer(stage, excluded) ?? registry.findVolunteer(stage);
	if (!device) {
		tasks.update(taskId, {
			state: "failed",
			error: `No volunteer is available for ${stage}`,
		});
		broadcastTask(taskId);
		return;
	}
	tasks.update(taskId, { state: "assigned" });
	const socket = sockets.get(device.deviceId);
	if (socket) {
		send(socket, {
			type: "stage.assign",
			taskId,
			stage,
			value,
		});
	}
	broadcastTask(taskId);
}

/**
 * Broadcasts the current state of a task when the task exists.
 *
 * @param taskId - The task identifier to broadcast.
 */
function broadcastTask(taskId: string): void {
	const task = tasks.get(taskId);
	if (task) {
		broadcast({
			type: "task.updated",
			task,
		});
	}
}

/**
 * Handles one validated client message for a connected device.
 *
 * @param socket - The WebSocket that sent the message.
 * @param deviceId - The identifier assigned to the WebSocket connection.
 * @param message - The client message to process.
 */
function handle(socket: WebSocket, deviceId: string, message: ClientMessage): void {
	if (message.type === "register") {
		const existingDevice = message.role === "volunteer"
			? registry.findByName(message.name, "volunteer")
			: undefined;
		if (existingDevice && existingDevice.deviceId !== deviceId) {
			registry.remove(existingDevice.deviceId);
			const existingSocket = sockets.get(existingDevice.deviceId);
			sockets.delete(existingDevice.deviceId);
			existingSocket?.close(1000, "Replaced by a newer connection with the same volunteer name");
		}
		const device: Device = {
			deviceId,
			name: message.name,
			role: message.role,
			stageNames: message.role === "volunteer"
				? (message.stageNames ?? ["stage_formula_multiply", "stage_formula_add"])
				: [],
			connectedAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString(),
		};
		registry.add(device);
		send(socket, {
			type: "registered",
			deviceId,
		});
		updateDevices();
		return;
	}

	if (message.type === "task.submit") {
		const parsed = TaskInput.safeParse(message.input);
		if (!parsed.success) {
			send(socket, {
				type: "error",
				message: "Input must match the shape expected for its task type",
			});
			return;
		}
		if (parsed.data.taskType === "task_type_llm") {
			send(socket, {
				type: "error",
				message: "LLM tasks are not runnable yet",
			});
			return;
		}
		const task = tasks.create(parsed.data);
		send(socket, {
			type: "task.accepted",
			task,
		});
		assign(task.taskId, parsed.data.input * 1, "stage_formula_multiply");
		return;
	}

	if (message.type === "task.get") {
		const task = tasks.get(message.taskId);
		if (task) {
			send(socket, {
				type: "task.updated",
				task,
			});
		} else {
			send(socket, {
				type: "error",
				message: "Task was not found",
			});
		}
		return;
	}

	if (message.type === "stage.result") {
		const device = registry.get(deviceId);
		if (!device || device.role !== "volunteer") {
			send(socket, {
				type: "error",
				message: "Only volunteer browser tabs may return stage results",
			});
			return;
		}
		const task = tasks.get(message.taskId);
		if (!task || nextStage(task) !== message.stage) {
			send(socket, {
				type: "error",
				message: "Unexpected stage result",
			});
			return;
		}
		const updated = tasks.addStage(task.taskId, {
			name: message.stage,
			value: message.value,
		});
		const upcoming = nextStage(updated);
		if (upcoming) {
			assign(updated.taskId, message.value, upcoming, [deviceId]);
		} else {
			tasks.update(updated.taskId, {
				state: "completed",
				result: message.value,
			});
			broadcastTask(updated.taskId);
		}
		return;
	}

	if (message.type === "stage.failed") {
		const device = registry.get(deviceId);
		if (!device || device.role !== "volunteer") {
			send(socket, {
				type: "error",
				message: "Only volunteer browser tabs may fail a stage",
			});
			return;
		}
		tasks.update(message.taskId, {
			state: "failed",
			error: message.error,
		});
		broadcastTask(message.taskId);
		return;
	}

	if (message.type === "signal") {
		const target = sockets.get(message.to);
		if (target) {
			send(target, {
				type: "signal",
				from: deviceId,
				data: message.data,
			});
		}
	}
}

const isProduction = process.env.NODE_ENV === "production";
const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), "../public");
const buildDirectory = join(publicDirectory, "dist");
const viteDevServer = isProduction
	? undefined
	: await (await import("vite")).createServer({
		root: publicDirectory,
		server: { middlewareMode: true },
		appType: "custom",
	});
const pageRoutes: Record<string, string> = {
	"/": "admin/index.html",
	"/admin": "admin/index.html",
	"/volunteer": "volunteer/index.html",
	"/debug_iframe": "debug_iframe/index.html",
};
const assetContentTypeByExtension: Record<string, string> = {
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

/**
 * Sends a browser page, transpiled through Vite in development or read from the production build.
 *
 * @param response - The HTTP response to write the page to.
 * @param pathname - The requested path, used to drive Vite's HTML transform in development.
 * @param sourcePath - The page's `index.html` path, relative to the public directory.
 */
async function sendPage(response: ServerResponse, pathname: string, sourcePath: string): Promise<void> {
	response.setHeader("content-type", "text/html; charset=utf-8");
	if (viteDevServer) {
		const html = readFileSync(join(publicDirectory, sourcePath), "utf-8");
		response.end(await viteDevServer.transformIndexHtml(pathname, html));
		return;
	}
	response.end(readFileSync(join(buildDirectory, sourcePath)));
}

/**
 * Serves a content-hashed asset from the production build's shared `assets` directory.
 *
 * @param response - The HTTP response to write the asset to.
 * @param pathname - The requested path.
 * @returns Whether a matching built asset was found and sent.
 */
function sendBuiltAsset(response: ServerResponse, pathname: string): boolean {
	if (!pathname.startsWith("/assets/")) return false;
	const assetsDirectory = join(buildDirectory, "assets");
	const assetPath = join(buildDirectory, pathname);
	if (!assetPath.startsWith(assetsDirectory + sep)) return false;
	try {
		response.setHeader(
			"content-type",
			assetContentTypeByExtension[extname(assetPath)] ?? "application/octet-stream",
		);
		response.end(readFileSync(assetPath));
		return true;
	} catch {
		return false;
	}
}

const httpServer = createHttpServer((request, response) => {
	const pathname = new URL(
		request.url ?? "/",
		`http://${request.headers.host ?? "localhost"}`,
	).pathname;

	const pageSourcePath = pageRoutes[pathname];
	if (pageSourcePath) {
		sendPage(response, pathname, pageSourcePath).catch((error: unknown) => console.error(error));
		return;
	}
	if (pathname === "/health") {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({
			ok: true,
			devices: volunteerDevices().length,
		}));
		return;
	}
	if (viteDevServer) {
		viteDevServer.middlewares(request, response, () => {
			response.statusCode = 404;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ error: "Not found" }));
		});
		return;
	}
	if (sendBuiltAsset(response, pathname)) return;
	response.statusCode = 404;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify({ error: "Not found" }));
});
const websocketServer = new WebSocketServer({ server: httpServer });
websocketServer.on("connection", (socket) => {
	const deviceId = `device-${crypto.randomUUID()}`;
	sockets.set(deviceId, socket);
	socket.on("message", (raw) => {
		try {
			handle(socket, deviceId, JSON.parse(raw.toString()) as ClientMessage);
		} catch {
			send(socket, {
				type: "error",
				message: "Invalid message",
			});
		}
	});
	socket.on("close", () => {
		sockets.delete(deviceId);
		registry.remove(deviceId);
		updateDevices();
	});
});
httpServer.listen(port, () => {
	console.log(`Central server listening on http://localhost:${port}`);
});
