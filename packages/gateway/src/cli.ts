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
	ClientMessageSchema,
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
import { PipelineRegistry, builtinPipelineSpecifications } from "./libs/pipeline_registry.js";

const options = new Command()
	.option("-p, --port <number>", "HTTP and WebSocket port", "8787")
	.option("--lease-ms <number>", "Assignment lease duration", "15000")
	.option("--submission-timeout-ms <number>", "Queued task deadline", "30000")
	.option("--max-attempts <number>", "Maximum assignment attempts", "3")
	.option("--state-file <path>", "Durable task state file", "gateway-state.json")
	.option("--auth-token <token>", "Required bearer token for development connections", "development-token")
	.option("--max-tasks-per-principal <number>", "Maximum non-terminal tasks per principal", "20")
	.option("--pipeline-file <path>", "JSON file containing additional pipeline specifications")
	.parse()
	.opts<{ port: string; leaseMs: string; submissionTimeoutMs: string; maxAttempts: string; stateFile: string; authToken: string; maxTasksPerPrincipal: string; pipelineFile?: string }>();
const port = Number(options.port);
const deviceRegistry = new DeviceRegistry();
const taskStore = new TaskStore(undefined, Number(options.submissionTimeoutMs), Number(options.leaseMs), options.stateFile);
const maximumAttempts = Number(options.maxAttempts);
const socketMap = new Map<string, WebSocket>();
const observerDeviceIds = new Set<string>();
const taskObserverDeviceIds = new Map<string, Set<string>>();
const authenticatedPrincipals = new Map<string, string>();
const devicePrincipalById = new Map<string, string>();
const maximumTasksPerPrincipal = Number(options.maxTasksPerPrincipal);
const pipelineRegistry = new PipelineRegistry(builtinPipelineSpecifications);
if (options.pipelineFile) {
	const additions = JSON.parse(readFileSync(options.pipelineFile, "utf8")) as unknown[];
	for (const specification of additions) pipelineRegistry.add(specification);
}

// Logs this gateway's own message traffic (one file per run), plus one log file per
// connected worker, relayed to us since a browser page cannot write files itself.
const logsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../logs");
const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
const gatewayMessageLogger = new MessageLogger(join(logsDirectory, `gateway-${runTimestamp}.jsonl`));
const workerMessageLoggers = new Map<string, MessageLogger>();
const maximumInboundMessageBytes = 8_500_000;

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

/** Sends a stable, machine-readable error. */
function sendError(socket: WebSocket, counterpart: LogCounterpart, code: Extract<GatewayMessage, { type: "error" }> ["code"], message: string, options: { taskId?: string; requestId?: string; details?: Record<string, unknown>; retryable?: boolean } = {}): void {
	send(socket, { type: "error", code, message, retryable: options.retryable ?? false, ...(options.taskId === undefined ? {} : { taskId: options.taskId }), ...(options.requestId === undefined ? {} : { requestId: options.requestId }), ...(options.details === undefined ? {} : { details: options.details }) }, counterpart);
}

/**
 * Returns the connected devices that can work on task stages.
 *
 * @returns The currently connected worker devices.
 */
function workerDevices(): Device[] {
	return deviceRegistry.list().filter((device) => device.deviceRole === "worker");
}

/** Returns every registered device for gateway observers and status updates. */
function connectedDevices(): Device[] {
	return deviceRegistry.list();
}

/**
 * Broadcasts the current worker device list to connected clients.
 */
function updateDevices(): void {
	broadcast({
		type: "devices",
		devices: connectedDevices(),
		revision: deviceRegistry.membershipRevision(),
	});
}

function publishDevice(change: ReturnType<DeviceRegistry["add"]> | ReturnType<DeviceRegistry["remove"]>): void {
	if (!change) return;
	if ("device" in change) broadcast({ type: change.kind === "joined" ? "device.joined" : "device.updated", device: change.device, revision: change.revision });
	else broadcast({ type: "device.left", deviceId: change.deviceId, revision: change.revision });
}

function releaseWorkerAssignment(workerDeviceId: string): void {
	const device = deviceRegistry.get(workerDeviceId);
	if (!device || device.deviceRole !== "worker") return;
	publishDevice(deviceRegistry.add({ ...device, activeAssignments: Math.max(0, (device.activeAssignments ?? 0) - 1), lastSeenAt: new Date().toISOString() }));
}

function occupyWorkerAssignment(workerDeviceId: string): void {
	const device = deviceRegistry.get(workerDeviceId);
	if (!device || device.deviceRole !== "worker") return;
	publishDevice(deviceRegistry.add({ ...device, activeAssignments: (device.activeAssignments ?? 0) + 1, lastSeenAt: new Date().toISOString() }));
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
	excluded: string[] = [], retryReason?: "lease_expired" | "worker_disconnected" | "worker_relinquished",
): void {
	const existing = taskStore.get(taskId);
	if (!existing || existing.state === "cancelled" || existing.state === "completed" || existing.state === "failed") return;
	if (existing.assignmentAttempts.length >= maximumAttempts) {
		taskStore.update(taskId, { state: "failed", error: "MAX_ATTEMPTS_EXHAUSTED", assignment: undefined });
		broadcastTask(taskId);
		return;
	}
	const device = retryReason === undefined
		? deviceRegistry.findWorker(stage, excluded) ?? deviceRegistry.findWorker(stage)
		: deviceRegistry.findWorker(stage, excluded);
	if (!device) {
		taskStore.update(taskId, { state: "queued", assignment: undefined });
		broadcastTask(taskId);
		return;
	}
	if (existing.assignment) releaseWorkerAssignment(existing.assignment.workerDeviceId);
	const task = taskStore.assign(taskId, device.deviceId, stage, value, retryReason);
	occupyWorkerAssignment(device.deviceId);
	const socket = socketMap.get(device.deviceId);
	if (socket) {
		send(socket, {
			type: "stage.assign",
			taskId,
			assignmentId: task.assignment!.assignmentId,
			attempt: task.assignment!.attempt,
			stage,
			value,
			leaseUntil: task.assignment!.leaseUntil,
		}, { role: device.deviceRole, deviceId: device.deviceId });
	}
	broadcastTask(taskId);
}

function scheduleQueuedTasks(): void {
	for (const task of taskStore.list()) {
		if (task.state !== "queued") continue;
		if (Date.parse(task.submissionDeadlineAt) <= Date.now()) {
			taskStore.update(task.taskId, { state: "failed", error: "SUBMISSION_DEADLINE_EXPIRED" });
			broadcastTask(task.taskId);
			continue;
		}
		const stage = TaskStore.nextStage(task);
		if (stage) assign(task.taskId, task.completedStages.at(-1)?.value ?? (task.input.taskType === "task_type_llm" ? StagePayloadFactory.llmPrompt(task.input.input) : StagePayloadFactory.formula(task.input.input)), stage);
	}
}

function recoverAssignments(): void {
	for (const task of taskStore.list()) {
		const assignment = task.assignment;
		if (!assignment || Date.parse(assignment.leaseUntil) > Date.now()) continue;
		assign(task.taskId, assignment.value, assignment.stage, [assignment.workerDeviceId], "lease_expired");
	}
}

function recoverWorkerAssignments(deviceId: string): void {
	for (const task of taskStore.list()) {
		const assignment = task.assignment;
		if (assignment?.workerDeviceId === deviceId) assign(task.taskId, assignment.value, assignment.stage, [deviceId], "worker_disconnected");
	}
}

/**
 * Broadcasts the current state of a task when the task exists.
 *
 * @param taskId - The task identifier to broadcast.
 */
function broadcastTask(taskId: string): void {
	const task = taskStore.get(taskId);
	if (!task) return;
	const recipients = new Set<string>([task.consumerDeviceId, ...(taskObserverDeviceIds.get(taskId) ?? []), ...(task.assignment ? [task.assignment.workerDeviceId] : [])]);
	for (const recipient of recipients) {
		const recipientSocket = socketMap.get(recipient);
		if (recipientSocket) send(recipientSocket, { type: "task.updated", task }, counterpartFor(recipient));
	}
}

function mayReadTask(deviceId: string, taskId: string): boolean {
	const task = taskStore.get(taskId);
	return task?.consumerDeviceId === deviceId || task?.assignment?.workerDeviceId === deviceId || taskObserverDeviceIds.get(taskId)?.has(deviceId) === true;
}

/**
 * Handles one validated client message for a connected device.
 *
 * @param socket - The WebSocket that sent the message.
 * @param deviceId - The identifier assigned to the WebSocket connection.
 * @param message - The client message to process.
 */
function handle(socket: WebSocket, deviceId: string, message: ClientMessage): void {
	if (message.type !== "authenticate" && !authenticatedPrincipals.has(deviceId)) { sendError(socket, counterpartFor(deviceId), "AUTHENTICATION_REQUIRED", "Authenticate before using the protocol", { retryable: false }); return; }
	if (message.type === "observe") {
		observerDeviceIds.add(deviceId);
		send(socket, { type: "devices", devices: connectedDevices(), revision: deviceRegistry.membershipRevision() }, counterpartFor(deviceId));
		return;
	}
	if (message.type === "authenticate") {
		if (message.token !== options.authToken) { sendError(socket, counterpartFor(deviceId), "AUTHENTICATION_REQUIRED", "Credentials were rejected", { retryable: false }); return; }
		const principal = `principal-${message.token.slice(0, 12)}`;
		authenticatedPrincipals.set(deviceId, principal);
		send(socket, { type: "authenticated", principal, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, counterpartFor(deviceId));
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
			principal: authenticatedPrincipals.get(deviceId)!,
			...(message.role === "worker" ? { workerState: message.ready === false ? "draining" as const : "ready" as const, ready: message.ready ?? true, maxConcurrentAssignments: message.maxConcurrentAssignments ?? 1, activeAssignments: 0 } : {}),
		};
		const change = deviceRegistry.add(device);
		devicePrincipalById.set(deviceId, authenticatedPrincipals.get(deviceId)!);
		send(socket, {
			type: "registered",
			deviceId,
		}, counterpartFor(deviceId, message));
		publishDevice(change);
		scheduleQueuedTasks();
		return;
	}
	if (!deviceRegistry.get(deviceId)) {
		sendError(socket, counterpartFor(deviceId), "NOT_REGISTERED", "Register before sending this message");
		return;
	}
	const activeDevice = deviceRegistry.get(deviceId)!;
	deviceRegistry.add({ ...activeDevice, lastSeenAt: new Date().toISOString() });

	if (message.type === "task.observe" || message.type === "task.unobserve" || message.type === "task.resync") {
		const task = taskStore.get(message.taskId);
		if (!task) { sendError(socket, counterpartFor(deviceId), "TASK_NOT_FOUND", "Task was not found", { taskId: message.taskId }); return; }
		if (message.type === "task.observe") {
			const requester = deviceRegistry.get(deviceId);
			if (requester?.deviceRole !== "consumer" || (task.consumerDeviceId !== deviceId && !taskObserverDeviceIds.get(task.taskId)?.has(deviceId))) { sendError(socket, counterpartFor(deviceId), "AUTHORISATION", "Task observation requires an owner grant", { taskId: task.taskId }); return; }
			const observers = taskObserverDeviceIds.get(task.taskId) ?? new Set<string>();
			observers.add(deviceId); taskObserverDeviceIds.set(task.taskId, observers);
		}
		if (message.type === "task.unobserve") taskObserverDeviceIds.get(task.taskId)?.delete(deviceId);
		if (message.type !== "task.unobserve") send(socket, { type: "task.updated", task }, counterpartFor(deviceId));
		return;
	}
	if (message.type === "task.observer.grant" || message.type === "task.observer.revoke") {
		const task = taskStore.get(message.taskId);
		if (!task) { sendError(socket, counterpartFor(deviceId), "TASK_NOT_FOUND", "Task was not found", { taskId: message.taskId }); return; }
		if (task.consumerDeviceId !== deviceId) { sendError(socket, counterpartFor(deviceId), "AUTHORISATION", "Only the task owner may manage observers", { taskId: task.taskId }); return; }
		const observer = deviceRegistry.get(message.consumerDeviceId);
		if (!observer || observer.deviceRole !== "consumer") { sendError(socket, counterpartFor(deviceId), "VALIDATION", "An observer must be a connected consumer", { taskId: task.taskId }); return; }
		const observers = taskObserverDeviceIds.get(task.taskId) ?? new Set<string>();
		if (message.type === "task.observer.grant") observers.add(message.consumerDeviceId); else observers.delete(message.consumerDeviceId);
		taskObserverDeviceIds.set(task.taskId, observers);
		return;
	}
	if (message.type === "devices.resync") { send(socket, { type: "devices", devices: connectedDevices(), revision: deviceRegistry.membershipRevision() }, counterpartFor(deviceId)); return; }

	if (message.type === "task.submit") {
		const device = deviceRegistry.get(deviceId);
		if (device?.deviceRole !== "consumer") {
			send(socket, {
				type: "error",
				code: "CONSUMER_REQUIRED",
				message: "Only consumer browser tabs may submit tasks",
				requestId: message.requestId,
			}, counterpartFor(deviceId));
			return;
		}
		const existingTask = taskStore.findByRequest(deviceId, message.requestId);
		if (existingTask) {
			if (JSON.stringify(existingTask.input) !== JSON.stringify(message.input)) {
				send(socket, { type: "error", code: "REQUEST_ID_CONFLICT", message: "requestId was already used with different task contents", requestId: message.requestId, taskId: existingTask.taskId }, counterpartFor(deviceId));
				return;
			}
			send(socket, { type: "task.accepted", requestId: message.requestId, task: existingTask }, counterpartFor(deviceId));
			return;
		}
		const principal = devicePrincipalById.get(deviceId)!;
		const activeTaskCount = taskStore.list().filter((candidate) => candidate.consumerPrincipal === principal && !["completed", "failed", "cancelled"].includes(candidate.state)).length;
		if (activeTaskCount >= maximumTasksPerPrincipal) { sendError(socket, counterpartFor(deviceId), "RATE_LIMITED", "The principal has reached its active-task limit", { requestId: message.requestId, retryable: true, details: { limit: maximumTasksPerPrincipal } }); return; }
		const pipeline = pipelineRegistry.select(message.input, message.pipelineId, message.pipelineVersion);
		if (message.input.taskType === "task_type_formula" && !pipeline) { sendError(socket, counterpartFor(deviceId), "NO_COMPATIBLE_WORKER", "No active compatible pipeline specification exists", { requestId: message.requestId, retryable: false }); return; }
		const task = taskStore.create(message.input, deviceId, message.requestId, principal, pipeline === undefined ? undefined : { pipelineId: pipeline.pipelineId, pipelineVersion: pipeline.version, pipelineStages: pipeline.stages.map((stage) => stage.name) });
		send(socket, {
			type: "task.accepted",
			requestId: message.requestId,
			task,
		}, counterpartFor(deviceId));
		const stage = TaskStore.nextStage(task);
		if (stage) assign(task.taskId, message.input.taskType === "task_type_llm" ? StagePayloadFactory.llmPrompt(message.input.input) : StagePayloadFactory.formula(message.input.input), stage);
		return;
	}

	if (message.type === "task.get") {
		const task = taskStore.get(message.taskId);
		if (task && mayReadTask(deviceId, task.taskId)) {
			send(socket, {
				type: "task.updated",
				task,
			}, counterpartFor(deviceId));
		} else if (task) {
			sendError(socket, counterpartFor(deviceId), "AUTHORISATION", "This connection is not allowed to read the task", { taskId: message.taskId });
		} else {
			send(socket, {
				type: "error",
				code: "TASK_NOT_FOUND",
				message: "Task was not found",
				taskId: message.taskId,
			}, counterpartFor(deviceId));
		}
		return;
	}

	if (message.type === "worker.state") {
		const device = deviceRegistry.get(deviceId);
		if (!device || device.deviceRole !== "worker") {
			send(socket, { type: "error", code: "WORKER_REQUIRED", message: "Only worker browser tabs may change worker state" }, counterpartFor(deviceId));
			return;
		}
		publishDevice(deviceRegistry.add({ ...device, workerState: message.state, ready: message.state === "ready", ...(message.maxConcurrentAssignments === undefined ? {} : { maxConcurrentAssignments: message.maxConcurrentAssignments }), lastSeenAt: new Date().toISOString() }));
		if (message.state === "ready") scheduleQueuedTasks();
		return;
	}

	if (message.type === "task.cancel") {
		const task = taskStore.get(message.taskId);
		if (!task) {
			send(socket, { type: "error", code: "TASK_NOT_FOUND", message: "Task was not found", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		if (task.consumerDeviceId !== deviceId) {
			send(socket, { type: "error", code: "TASK_OWNER_MISMATCH", message: "Only the task owner may cancel this task", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		const assignment = task.assignment;
		const cancelled = taskStore.cancel(task.taskId, message.reason);
		if (assignment) releaseWorkerAssignment(assignment.workerDeviceId);
		if (assignment) {
			const workerSocket = socketMap.get(assignment.workerDeviceId);
			if (workerSocket) send(workerSocket, { type: "stage.cancel", taskId: task.taskId, assignmentId: assignment.assignmentId, attempt: assignment.attempt, reason: message.reason }, counterpartFor(assignment.workerDeviceId));
		}
		broadcastTask(cancelled.taskId);
		return;
	}

	if (message.type === "stage.accepted" || message.type === "stage.relinquish") {
		const device = deviceRegistry.get(deviceId);
		const task = taskStore.get(message.taskId);
		const assignment = task?.assignment;
		if (!device || device.deviceRole !== "worker") {
			send(socket, { type: "error", code: "WORKER_REQUIRED", message: "Only worker browser tabs may update assignments" }, counterpartFor(deviceId));
			return;
		}
		if (!assignment || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt || assignment.workerDeviceId !== deviceId) {
			send(socket, { type: "error", code: "STALE_ASSIGNMENT", message: "The stage assignment is no longer current", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		if (message.type === "stage.accepted") {
			taskStore.acceptAssignment(task.taskId);
			broadcastTask(task.taskId);
		} else {
			assign(task.taskId, assignment.value, assignment.stage, [deviceId], "worker_relinquished");
		}
		return;
	}

	if (message.type === "stage.result") {
		const device = deviceRegistry.get(deviceId);
		if (!device || device.deviceRole !== "worker") {
			send(socket, {
				type: "error",
				code: "WORKER_REQUIRED",
				message: "Only worker browser tabs may return stage results",
			}, counterpartFor(deviceId));
			return;
		}
		const task = taskStore.get(message.taskId);
		if (!task) {
			send(socket, { type: "error", code: "TASK_NOT_FOUND", message: "Task was not found", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		const assignment = task.assignment;
		if (!assignment || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt) {
			if (task.acknowledgedAssignmentIds?.includes(message.assignmentId)) {
				send(socket, { type: "stage.result.accepted", taskId: task.taskId, assignmentId: message.assignmentId, attempt: message.attempt, revision: task.revision, status: task.state === "completed" ? "completed" : "assigned" }, counterpartFor(deviceId));
				return;
			}
			send(socket, {
				type: "error",
				code: "STALE_ASSIGNMENT",
				message: "The stage assignment is no longer current",
				taskId: message.taskId,
			}, counterpartFor(deviceId));
			return;
		}
		if (assignment.workerDeviceId !== deviceId) {
			send(socket, { type: "error", code: "ASSIGNMENT_OWNER_MISMATCH", message: "Only the assigned worker may return this stage result", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		if (assignment.stage !== message.stage) {
			send(socket, { type: "error", code: "ASSIGNMENT_STAGE_MISMATCH", message: "The stage result does not match the current assignment", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		if (task.state !== "running") {
			send(socket, { type: "error", code: "ASSIGNMENT_NOT_ACCEPTED", message: "A stage assignment must be accepted before returning a result", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		const updated = taskStore.addStage(task.taskId, {
			name: message.stage,
			value: message.value,
		}, message.assignmentId);
		releaseWorkerAssignment(deviceId);
		const upcoming = TaskStore.nextStage(updated);
		if (upcoming) {
			// An LLM task's shards must all run on the same device: later shards need the
			// key-value cache and hand-off tensors this device already holds in memory.
			// The formula pipeline instead prefers handing the next stage to a different
			// device, to demonstrate multiple workers cooperating on one task.
			const excluded = updated.input.taskType === "task_type_llm" ? [] : [deviceId];
			assign(updated.taskId, message.value, upcoming, excluded);
		} else {
			const completed = taskStore.update(updated.taskId, {
				state: "completed",
				result: message.value,
			});
			broadcastTask(updated.taskId);
			send(socket, { type: "stage.result.accepted", taskId: completed.taskId, assignmentId: message.assignmentId, attempt: message.attempt, revision: completed.revision, status: "completed" }, counterpartFor(deviceId));
			return;
		}
		const assigned = taskStore.get(updated.taskId)!;
		send(socket, { type: "stage.result.accepted", taskId: assigned.taskId, assignmentId: message.assignmentId, attempt: message.attempt, revision: assigned.revision, status: "assigned" }, counterpartFor(deviceId));
		return;
	}

	if (message.type === "stage.failed") {
		const device = deviceRegistry.get(deviceId);
		if (!device || device.deviceRole !== "worker") {
			send(socket, {
				type: "error",
				code: "WORKER_REQUIRED",
				message: "Only worker browser tabs may fail a stage",
			}, counterpartFor(deviceId));
			return;
		}
		const task = taskStore.get(message.taskId);
		if (!task) {
			send(socket, { type: "error", code: "TASK_NOT_FOUND", message: "Task was not found", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		const assignment = task.assignment;
		if (!assignment || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt) {
			send(socket, { type: "error", code: "STALE_ASSIGNMENT", message: "The stage assignment is no longer current", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		if (assignment.workerDeviceId !== deviceId) {
			send(socket, { type: "error", code: "ASSIGNMENT_OWNER_MISMATCH", message: "Only the assigned worker may fail this stage", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		if (assignment.stage !== message.stage) {
			send(socket, { type: "error", code: "ASSIGNMENT_STAGE_MISMATCH", message: "The stage failure does not match the current assignment", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		if (task.state !== "running") {
			send(socket, { type: "error", code: "ASSIGNMENT_NOT_ACCEPTED", message: "A stage assignment must be accepted before failing", taskId: message.taskId }, counterpartFor(deviceId));
			return;
		}
		taskStore.update(message.taskId, {
			state: "failed",
			error: message.error,
			assignment: undefined,
		});
		releaseWorkerAssignment(deviceId);
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
		const rawBuffer = Array.isArray(raw)
			? Buffer.concat(raw)
			: raw instanceof ArrayBuffer
				? Buffer.from(new Uint8Array(raw))
				: raw;
		if (rawBuffer.length > maximumInboundMessageBytes) {
			send(socket, { type: "error", code: "MESSAGE_TOO_LARGE", message: "Message exceeds the maximum allowed size" }, counterpartFor(deviceId));
			return;
		}
		try {
			const parsed = ClientMessageSchema.safeParse(JSON.parse(rawBuffer.toString()));
			if (!parsed.success) {
				send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Message does not match the supported protocol" }, counterpartFor(deviceId));
				return;
			}
			const message = parsed.data;
			if (message.type !== "observe") gatewayMessageLogger.log("received", counterpartFor(deviceId, message), message.type, message);
			handle(socket, deviceId, message);
		} catch {
			send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Message is not valid JSON" }, counterpartFor(deviceId));
		}
	});
	socket.on("close", () => {
		socketMap.delete(deviceId);
		observerDeviceIds.delete(deviceId);
		for (const observers of taskObserverDeviceIds.values()) observers.delete(deviceId);
		devicePrincipalById.delete(deviceId);
		authenticatedPrincipals.delete(deviceId);
		publishDevice(deviceRegistry.remove(deviceId));
		recoverWorkerAssignments(deviceId);
		updateDevices();
	});
});
const recoveryTimer = setInterval(() => {
	recoverAssignments();
	scheduleQueuedTasks();
}, Math.max(100, Math.min(Number(options.leaseMs), Number(options.submissionTimeoutMs))));
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
	clearInterval(recoveryTimer);
	if (viteDevServer) await viteDevServer.close();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
