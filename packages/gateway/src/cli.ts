// node imports
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// npm imports
import { Command } from "commander";
import { WebSocketServer, type WebSocket } from "ws";
import {
	StagePayloadFactory,
	TaskInput,
	type ClientMessage,
	type Device,
	type GatewayMessage,
	type StageName,
	type StagePayload,
} from "@webai/protocol";
import { MessageLogger, type LogCounterpart } from "@webai/protocol/message_logger";

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
const observerDeviceIds = new Set<string>();

// Logs this gateway's own message traffic (one file per run), plus one log file per
// connected worker, relayed to us since a browser page cannot write files itself.
const logsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../logs");
const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
const gatewayMessageLogger = new MessageLogger(join(logsDirectory, `gateway-${runTimestamp}.jsonl`));
const workerMessageLoggers = new Map<string, MessageLogger>();

/**
 * Returns the log file for a connected worker's relayed message log, creating it on
 * first use.
 *
 * @param deviceId - The worker device identifier.
 * @returns The message logger that appends to that worker's own log file.
 */
function workerMessageLogger(deviceId: string): MessageLogger {
	let logger = workerMessageLoggers.get(deviceId);
	if (!logger) {
		logger = new MessageLogger(join(logsDirectory, `worker-${deviceId}.jsonl`));
		workerMessageLoggers.set(deviceId, logger);
	}
	return logger;
}

/**
 * Resolves the role and device identifier to log for a connected device, from this
 * gateway's own point of view.
 *
 * @param deviceId - The device identifier assigned to the WebSocket connection.
 * @param registerMessage - The client's own "register" message, when this is being resolved
 * for that message itself, before the device has been added to the registry.
 * @returns The counterpart to record in a log entry.
 */
function counterpartFor(deviceId: string, registerMessage?: ClientMessage): LogCounterpart {
	if (registerMessage?.type === "register") return { role: registerMessage.role, deviceId };
	if (observerDeviceIds.has(deviceId)) return { role: "observer", deviceId };
	const device = deviceRegistry.get(deviceId);
	return { role: device?.deviceRole ?? "unknown", deviceId };
}

/**
 * Sends a gateway message when a WebSocket is still open, and logs it as sent.
 *
 * @param socket - The WebSocket that should receive the message.
 * @param message - The gateway message to serialize and send.
 * @param counterpart - Who the message is being sent to.
 */
function send(socket: WebSocket, message: GatewayMessage, counterpart: LogCounterpart): void {
	if (![...observerDeviceIds].some((deviceId): boolean => socketMap.get(deviceId) === socket)) {
		gatewayMessageLogger.log("sent", counterpart, message.type, message);
	}
	if (socket.readyState === socket.OPEN) {
		socket.send(JSON.stringify(message));
	}
}

/**
 * Sends a gateway message to every connected WebSocket.
 *
 * @param message - The gateway message to broadcast.
 */
function broadcast(message: GatewayMessage): void {
	for (const [deviceId, socket] of socketMap.entries()) {
		send(socket, message, counterpartFor(deviceId));
	}
}

/**
 * Returns the connected devices that can work on task stages.
 *
 * @returns The currently connected worker devices.
 */
function workerDevices(): Device[] {
	return deviceRegistry.list().filter((device) => device.deviceRole === "worker");
}

/**
 * Broadcasts the current worker device list to connected clients.
 */
function updateDevices(): void {
	broadcast({
		type: "devices",
		devices: workerDevices(),
	});
}

/**
 * Assigns a task stage to an available worker device.
 *
 * @param taskId - The task identifier to assign.
 * @param value - The value that the worker must process.
 * @param stage - The stage to assign.
 * @param excluded - Device identifiers that must not receive the assignment.
 */
function assign(
	taskId: string,
	value: StagePayload,
	stage: StageName,
	excluded: string[] = [],
): void {
	const device = deviceRegistry.findWorker(stage, excluded) ?? deviceRegistry.findWorker(stage);
	if (!device) {
		taskStore.update(taskId, {
			state: "failed",
			error: `No worker is available for ${stage}`,
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
		}, { role: device.deviceRole, deviceId: device.deviceId });
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
	if (message.type === "observe") {
		observerDeviceIds.add(deviceId);
		send(socket, { type: "devices", devices: workerDevices() }, counterpartFor(deviceId));
		return;
	}
	if (message.type === "register") {
		const existingDevice = message.role === "worker"
			? deviceRegistry.findByName(message.name, "worker")
			: undefined;
		if (existingDevice && existingDevice.deviceId !== deviceId) {
			deviceRegistry.remove(existingDevice.deviceId);
			const existingSocket = socketMap.get(existingDevice.deviceId);
			socketMap.delete(existingDevice.deviceId);
			existingSocket?.close(1000, "Replaced by a newer connection with the same worker name");
		}
		const device: Device = {
			deviceId,
			name: message.name,
			deviceRole: message.role,
			stageNames: message.role === "worker"
				? (message.stageNames ?? ["stage_formula_multiply", "stage_formula_add"])
				: [],
			connectedAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString(),
		};
		deviceRegistry.add(device);
		send(socket, {
			type: "registered",
			deviceId,
		}, counterpartFor(deviceId, message));
		updateDevices();
		return;
	}

	if (message.type === "task.submit") {
		const parsed = TaskInput.safeParse(message.input);
		if (!parsed.success) {
			send(socket, {
				type: "error",
				message: "Input must match the shape expected for its task type",
			}, counterpartFor(deviceId));
			return;
		}
		const task = taskStore.create(parsed.data);
		send(socket, {
			type: "task.accepted",
			task,
		}, counterpartFor(deviceId));
		if (parsed.data.taskType === "task_type_llm") {
			assign(task.taskId, StagePayloadFactory.llmPrompt(parsed.data.input), "stage_llm_shard1");
		} else {
			assign(task.taskId, StagePayloadFactory.formula(parsed.data.input), "stage_formula_multiply");
		}
		return;
	}

	if (message.type === "task.get") {
		const task = taskStore.get(message.taskId);
		if (task) {
			send(socket, {
				type: "task.updated",
				task,
			}, counterpartFor(deviceId));
		} else {
			send(socket, {
				type: "error",
				message: "Task was not found",
			}, counterpartFor(deviceId));
		}
		return;
	}

	if (message.type === "stage.result") {
		const device = deviceRegistry.get(deviceId);
		if (!device || device.deviceRole !== "worker") {
			send(socket, {
				type: "error",
				message: "Only worker browser tabs may return stage results",
			}, counterpartFor(deviceId));
			return;
		}
		const task = taskStore.get(message.taskId);
		if (!task || TaskStore.nextStage(task) !== message.stage) {
			send(socket, {
				type: "error",
				message: "Unexpected stage result",
			}, counterpartFor(deviceId));
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
			// device, to demonstrate multiple workers cooperating on one task.
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
		if (!device || device.deviceRole !== "worker") {
			send(socket, {
				type: "error",
				message: "Only worker browser tabs may fail a stage",
			}, counterpartFor(deviceId));
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
			}, counterpartFor(message.to));
		}
		return;
	}

	if (message.type === "log.entry") {
		workerMessageLogger(deviceId).log(
			message.direction,
			{ role: "gateway" },
			message.messageType,
			message.payload,
			message.timestamp,
		);
		return;
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
	"/": "home/index.html",
	"/home": "home/index.html",
	"/debug_iframe": "debug_iframe/index.html",
	"/debug_iframe_formula": "debug_iframe_formula/index.html",
	"/debug_iframe_llm": "debug_iframe_llm/index.html",
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
	// own public directory. Rather than duplicate ~860 MB into packages/gateway too, the
	// worker page fetches them straight from there, dev-server only, at the same URL the
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
	// for itself (see that package's vite.config.js). Resolve the package through Node's own
	// module resolution rather than a hardcoded relative path — npm workspaces may hoist
	// onnxruntime-web to the repo root's node_modules instead of nesting it under this
	// package, depending on what else is installed.
	const ortAssetNames = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
	const ortAssetName = pathname.slice(1);
	if (ortAssetNames.includes(ortAssetName)) {
		const ortDistDirectory = dirname(fileURLToPath(import.meta.resolve("onnxruntime-web")));
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
			devices: workerDevices().length,
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
			const message = JSON.parse(raw.toString()) as ClientMessage;
			if (message.type !== "observe") gatewayMessageLogger.log("received", counterpartFor(deviceId, message), message.type, message);
			handle(socket, deviceId, message);
		} catch {
			send(socket, {
				type: "error",
				message: "Invalid message",
			}, counterpartFor(deviceId));
		}
	});
	socket.on("close", () => {
		socketMap.delete(deviceId);
		observerDeviceIds.delete(deviceId);
		deviceRegistry.remove(deviceId);
		updateDevices();
	});
});
httpServer.listen(port, () => {
	console.log(`Central gateway listening on http://localhost:${port}`);
});

/**
 * Closes every open connection and server on Ctrl+C (or a container/process manager
 * stop), so the process exits promptly instead of `tsx watch` having to force-kill it
 * after its own timeout.
 */
async function shutdown(): Promise<void> {
	console.log("\nShutting down...");
	for (const socket of socketMap.values()) socket.close();
	websocketServer.close();
	httpServer.close();
	if (viteDevServer) await viteDevServer.close();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
