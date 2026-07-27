// node imports
import { existsSync, readFileSync } from "node:fs";
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
	type StagePayload,
} from "@webai/protocol";

// local imports
import { DeviceRegistry } from "./libs/device_registry.js";
import { TaskStore } from "./libs/task_store.js";

const options = new Command()
	.option("-p, --port <number>", "HTTP and WebSocket port", "8787")
	.parse()
	.opts<{ port: string }>();
const port = Number(options.port);
const deviceRegistry = new DeviceRegistry();
const taskStore = new TaskStore();
const socketMap = new Map<string, WebSocket>();

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
	for (const socket of socketMap.values()) {
		send(socket, message);
	}
}

/**
 * Returns the connected devices that can volunteer for task stages.
 *
 * @returns The currently connected volunteer devices.
 */
function volunteerDevices(): Device[] {
	return deviceRegistry.list().filter((device) => device.deviceRole === "volunteer");
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
	value: StagePayload,
	stage: StageName,
	excluded: string[] = [],
): void {
	const device = deviceRegistry.findVolunteer(stage, excluded) ?? deviceRegistry.findVolunteer(stage);
	if (!device) {
		taskStore.update(taskId, {
			state: "failed",
			error: `No volunteer is available for ${stage}`,
		});
		broadcastTask(taskId);
		return;
	}
	taskStore.update(taskId, { state: "assigned" });
	const socket = socketMap.get(device.deviceId);
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
	const task = taskStore.get(taskId);
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
			? deviceRegistry.findByName(message.name, "volunteer")
			: undefined;
		if (existingDevice && existingDevice.deviceId !== deviceId) {
			deviceRegistry.remove(existingDevice.deviceId);
			const existingSocket = socketMap.get(existingDevice.deviceId);
			socketMap.delete(existingDevice.deviceId);
			existingSocket?.close(1000, "Replaced by a newer connection with the same volunteer name");
		}
		const device: Device = {
			deviceId,
			name: message.name,
			deviceRole: message.role,
			stageNames: message.role === "volunteer"
				? (message.stageNames ?? ["stage_formula_multiply", "stage_formula_add"])
				: [],
			connectedAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString(),
		};
		deviceRegistry.add(device);
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
		const task = taskStore.create(parsed.data);
		send(socket, {
			type: "task.accepted",
			task,
		});
		if (parsed.data.taskType === "task_type_llm") {
			assign(task.taskId, { text: parsed.data.input }, "stage_llm_shard1");
		} else {
			assign(task.taskId, parsed.data.input, "stage_formula_multiply");
		}
		return;
	}

	if (message.type === "task.get") {
		const task = taskStore.get(message.taskId);
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
		const device = deviceRegistry.get(deviceId);
		if (!device || device.deviceRole !== "volunteer") {
			send(socket, {
				type: "error",
				message: "Only volunteer browser tabs may return stage results",
			});
			return;
		}
		const task = taskStore.get(message.taskId);
		if (!task || TaskStore.nextStage(task) !== message.stage) {
			send(socket, {
				type: "error",
				message: "Unexpected stage result",
			});
			return;
		}
		const updated = taskStore.addStage(task.taskId, {
			name: message.stage,
			value: message.value,
		});
		const upcoming = TaskStore.nextStage(updated);
		if (upcoming) {
			// An LLM task's shards must all run on the same device: later shards need the
			// key-value cache and hand-off tensors this device already holds in memory.
			// The formula pipeline instead prefers handing the next stage to a different
			// device, to demonstrate multiple volunteers cooperating on one task.
			const excluded = updated.input.taskType === "task_type_llm" ? [] : [deviceId];
			assign(updated.taskId, message.value, upcoming, excluded);
		} else {
			taskStore.update(updated.taskId, {
				state: "completed",
				result: message.value,
			});
			broadcastTask(updated.taskId);
		}
		return;
	}

	if (message.type === "stage.failed") {
		const device = deviceRegistry.get(deviceId);
		if (!device || device.deviceRole !== "volunteer") {
			send(socket, {
				type: "error",
				message: "Only volunteer browser tabs may fail a stage",
			});
			return;
		}
		taskStore.update(message.taskId, {
			state: "failed",
			error: message.error,
		});
		broadcastTask(message.taskId);
		return;
	}

	if (message.type === "signal") {
		const target = socketMap.get(message.to);
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

	// The qwen3-0.6b shard files are large, gitignored, and generated once as an explicit setup
	// step (see packages/_onnx_experiments/tools/verify_qwen3_shards.mjs) into that package's
	// own public directory. Rather than duplicate ~860 MB into packages/server too, the
	// volunteer page fetches them straight from there, dev-server only, at the same URL the
	// existing onnxruntime_qwen3-0.6b-with-shards prototype already uses for itself.
	const shardMatch = /^\/onnxruntime_qwen3-0\.6b-with-shards\/shards\/shard-([123])\.onnx$/.exec(pathname);
	if (shardMatch) {
		const shardDirectory = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../_onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/shards",
		);
		const shardPath = join(shardDirectory, `shard-${shardMatch[1]}.onnx`);
		if (!existsSync(shardPath)) {
			response.statusCode = 404;
			response.end(`Shard file not found at ${shardPath}. Generate the qwen3-0.6b shards into packages/_onnx_experiments first.`);
			return;
		}
		response.setHeader("content-type", "application/octet-stream");
		response.end(readFileSync(shardPath));
		return;
	}

	// onnxruntime-web fetches its WebAssembly runtime by URL rather than through an import, so
	// it needs to be served explicitly, same as the existing _onnx_experiments prototype does
	// for itself (see that package's vite.config.js).
	const ortAssetNames = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
	const ortAssetName = pathname.slice(1);
	if (ortAssetNames.includes(ortAssetName)) {
		const ortDistDirectory = join(
			dirname(fileURLToPath(import.meta.url)),
			"../node_modules/onnxruntime-web/dist",
		);
		response.setHeader("content-type", ortAssetName.endsWith(".wasm") ? "application/wasm" : "text/javascript");
		response.end(readFileSync(join(ortDistDirectory, ortAssetName)));
		return;
	}

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
	socketMap.set(deviceId, socket);
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
		socketMap.delete(deviceId);
		deviceRegistry.remove(deviceId);
		updateDevices();
	});
});
httpServer.listen(port, () => {
	console.log(`Central server listening on http://localhost:${port}`);
});
