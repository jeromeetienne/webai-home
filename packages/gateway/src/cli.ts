// node imports
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// npm imports
import { Command } from "commander";
import { WebSocketServer, type WebSocket } from "ws";
import {
	StagePayloadFactory,
	ClientEnvelopeSchema,
	DiagnosticsBatchSchema,
	protocolVersion,
	supportedProtocolVersions,
	type ClientMessage,
	type Device,
	type DeviceActivity,
	type GatewayMessage,
	type StageName,
	type StagePayload,
} from "@webai/protocol";
import { Envelope } from "@webai/protocol/envelope";
import { MessageLogger, type LogCounterpart } from "@webai/protocol/message_logger";
import { TaskProjection } from "@webai/protocol/task_projection";

// local imports
import { DeviceRegistry, type DeviceRegistryChange } from "./libs/device_registry.js";
import { TaskStore } from "./libs/task_store.js";
import { PipelineRegistry, builtinPipelineSpecifications } from "./libs/pipeline_registry.js";
import { StagePolicyResolver } from "./libs/stage_policy_resolver.js";
import { DiagnosticsRateLimiter } from "./libs/diagnostics_rate_limiter.js";
import { SessionRegistry } from "./libs/session_registry.js";
import { WorkerPlacement } from "./libs/worker_placement.js";

const options = new Command()
	.option("-p, --port <number>", "HTTP and WebSocket port", "8787")
	.option("--lease-ms <number>", "Assignment lease duration", "15000")
	.option("--submission-timeout-ms <number>", "Queued task deadline", "30000")
	.option("--max-attempts <number>", "Maximum assignment attempts", "3")
	.option("--state-file <path>", "Durable task state file", "gateway-state.json")
	.option("--auth-token <token>", "Required bearer token for development connections", "development-token")
	.option("--max-tasks-per-principal <number>", "Maximum non-terminal tasks per principal", "20")
	.option("--session-ms <number>", "How long an authenticated session lasts before the client must authenticate again", "3600000")
	.option("--pipeline-file <path>", "JSON file containing additional pipeline specifications")
	.option("--device-activity-coalesce-ms <number>", "How long device activity changes are batched before one combined update is sent", "250")
	.parse()
	.opts<{ port: string; leaseMs: string; submissionTimeoutMs: string; maxAttempts: string; stateFile: string; authToken: string; maxTasksPerPrincipal: string; sessionMs: string; pipelineFile?: string; deviceActivityCoalesceMs: string }>();
const port = Number(options.port);
const deviceRegistry = new DeviceRegistry();
const taskStore = new TaskStore(undefined, Number(options.submissionTimeoutMs), Number(options.leaseMs), options.stateFile);
const maximumAttempts = Number(options.maxAttempts);
const socketMap = new Map<string, WebSocket>();
const observerDeviceIds = new Set<string>();
// Device membership is opt-in. A connection receives "devices", "device.joined",
// "device.updated", "device.activity", and "device.left" only after asking for them with
// "devices.subscribe", or by connecting as an observer. Workers and consumers never ask,
// so a cluster with no dashboard attached exchanges no device membership messages at all.
const deviceSubscriberIds = new Set<string>();
const pendingActivityDeviceIds = new Set<string>();
let deviceActivityTimer: NodeJS.Timeout | undefined;
const deviceActivityCoalesceMs = Number(options.deviceActivityCoalesceMs);
const taskObserverDeviceIds = new Map<string, Set<string>>();
const sessionRegistry = new SessionRegistry(Number(options.sessionMs));
const maximumTasksPerPrincipal = Number(options.maxTasksPerPrincipal);
const pipelineRegistry = new PipelineRegistry(builtinPipelineSpecifications);
if (options.pipelineFile) {
	const additions = JSON.parse(readFileSync(options.pipelineFile, "utf8")) as unknown[];
	for (const specification of additions) pipelineRegistry.add(specification);
}
const stagePolicyResolver = new StagePolicyResolver(pipelineRegistry, Number(options.leaseMs));

// Logs this gateway's own message traffic (one file per run), plus one log file per
// connected worker, relayed to us since a browser page cannot write files itself.
const logsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../logs");
const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
const gatewayMessageLogger = new MessageLogger(join(logsDirectory, `gateway-${runTimestamp}.jsonl`));
const workerMessageLoggers = new Map<string, MessageLogger>();
const maximumInboundMessageBytes = 8_500_000;

/**
 * Caps how many diagnostic entries each worker may report, so that reporting cannot grow
 * without bound now that it has its own transport.
 */
const diagnosticsRateLimiter = new DiagnosticsRateLimiter();

/**
 * The largest diagnostics report the gateway will read, in bytes.
 *
 * A report carries no message bodies, only a message type and a timestamp per entry, so the
 * largest allowed batch fits inside this comfortably. The limit is here to stop the gateway
 * buffering an unbounded request body before it has validated anything.
 */
const maximumDiagnosticsRequestBytes = 64_000;

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
 * @param inReplyTo - The identifier of the client request this message answers. Leave it out
 * for a message the gateway pushes on its own initiative; that absence is what tells a client
 * the message is a push rather than an answer.
 */
function send(socket: WebSocket, message: GatewayMessage, counterpart: LogCounterpart, inReplyTo?: string): void {
	const frame = Envelope.fromGateway(message, inReplyTo);
	if (![...observerDeviceIds].some((deviceId): boolean => socketMap.get(deviceId) === socket)) {
		gatewayMessageLogger.log("sent", counterpart, message.type, message, frame.ts, frame);
	}
	if (socket.readyState === socket.OPEN) {
		socket.send(JSON.stringify(frame));
	}
}

/**
 * Sends a gateway message to the connections that asked for device membership.
 *
 * @param message - The gateway message to send.
 */
function sendToDeviceSubscribers(message: GatewayMessage): void {
	for (const deviceId of deviceSubscriberIds) {
		const socket = socketMap.get(deviceId);
		if (socket) send(socket, message, counterpartFor(deviceId));
	}
}

/**
 * Sends a stable, machine-readable error.
 *
 * An error is always an answer to something, so it echoes the identifier of the request that
 * caused it whenever that request is known.
 */
function sendError(socket: WebSocket, inReplyTo: string | undefined, counterpart: LogCounterpart, code: Extract<GatewayMessage, { type: "error" }> ["code"], message: string, options: { taskId?: string; requestId?: string; details?: Record<string, unknown>; retryable?: boolean } = {}): void {
	send(socket, { type: "error", code, message, retryable: options.retryable ?? false, ...(options.taskId === undefined ? {} : { taskId: options.taskId }), ...(options.requestId === undefined ? {} : { requestId: options.requestId }), ...(options.details === undefined ? {} : { details: options.details }) }, counterpart, inReplyTo);
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
 * Sends the full device list to the connections that asked for device membership.
 */
function updateDevices(): void {
	sendToDeviceSubscribers({
		type: "devices",
		devices: connectedDevices(),
		revision: deviceRegistry.membershipRevision(),
	});
}

/**
 * Reduces a device record to the fields that change as work is assigned to it.
 *
 * @param device - The device to reduce.
 * @returns The device's activity fields.
 */
function deviceActivityOf(device: Device): DeviceActivity {
	return {
		deviceId: device.deviceId,
		lastSeenAt: device.lastSeenAt,
		...(device.workerState === undefined ? {} : { workerState: device.workerState }),
		...(device.ready === undefined ? {} : { ready: device.ready }),
		...(device.activeAssignments === undefined ? {} : { activeAssignments: device.activeAssignments }),
	};
}

/**
 * Sends one combined `device.activity` message for every device whose activity changed
 * since the last flush, then clears the batch.
 *
 * Batching matters because a worker's assignment counter moves twice per stage, once when
 * the stage is assigned and once when the result arrives. Without batching, a short task
 * on a small cluster produces one message per device per counter movement.
 */
function flushDeviceActivity(): void {
	deviceActivityTimer = undefined;
	const devices = [...pendingActivityDeviceIds]
		.map((deviceId) => deviceRegistry.get(deviceId))
		.filter((device): device is Device => device !== undefined)
		.map(deviceActivityOf);
	pendingActivityDeviceIds.clear();
	if (devices.length === 0 || deviceSubscriberIds.size === 0) return;
	sendToDeviceSubscribers({ type: "device.activity", devices, revision: deviceRegistry.membershipRevision() });
}

/**
 * Announces what storing a device changed.
 *
 * A new device and a change to a device's own description are announced immediately. A
 * change to how busy a device is joins the next batch instead. A change that moved
 * nothing worth announcing is dropped.
 *
 * @param change - What storing the device changed, or the removal of a device.
 */
function publishDevice(change: DeviceRegistryChange | ReturnType<DeviceRegistry["remove"]>): void {
	if (!change) return;
	if ("deviceId" in change && "device" in change === false) {
		pendingActivityDeviceIds.delete(change.deviceId);
		sendToDeviceSubscribers({ type: "device.left", deviceId: change.deviceId, revision: change.revision });
		return;
	}
	const deviceChange = change as DeviceRegistryChange;
	if (deviceChange.kind === "unchanged") return;
	if (deviceChange.kind === "activity_changed") {
		if (deviceSubscriberIds.size === 0) return;
		pendingActivityDeviceIds.add(deviceChange.device.deviceId);
		if (deviceActivityTimer === undefined) deviceActivityTimer = setTimeout(flushDeviceActivity, deviceActivityCoalesceMs);
		return;
	}
	sendToDeviceSubscribers({ type: deviceChange.kind === "joined" ? "device.joined" : "device.updated", device: deviceChange.device, revision: deviceChange.revision });
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

/** How one call to `assign` differs from placing a stage on any free worker. */
type AssignOptions = {
	/** Device identifiers that must not receive the assignment. */
	excluded?: string[];
	/** Why this assignment replaces an earlier one, when it does. */
	retryReason?: "lease_expired" | "worker_disconnected" | "worker_relinquished";
	/**
	 * A worker to place the stage on before considering any other, used when the stage keeps
	 * state in the memory of one device and must go back to the device holding that state.
	 */
	preferredWorkerDeviceId?: string | undefined;
	/**
	 * Whether the assignment the preferred worker previously held has already been released.
	 * This decides how that worker's assignment counter is compared against its own limit.
	 */
	isPreviousAssignmentReleased?: boolean;
};

/**
 * Assigns a task stage to an available worker device.
 *
 * @param taskId - The task identifier to assign.
 * @param value - The value that the worker must process.
 * @param stage - The stage to assign.
 * @param options - How this assignment differs from placing the stage on any free worker.
 */
function assign(
	taskId: string,
	value: StagePayload,
	stage: StageName,
	options: AssignOptions = {},
): void {
	const { excluded = [], retryReason, preferredWorkerDeviceId, isPreviousAssignmentReleased = false } = options;
	const existing = taskStore.get(taskId);
	if (!existing || existing.state === "cancelled" || existing.state === "completed" || existing.state === "failed") return;
	if (existing.currentStageAttempts >= maximumAttempts) {
		taskStore.update(taskId, { state: "failed", error: "MAX_ATTEMPTS_EXHAUSTED", assignment: undefined });
		broadcastTask(taskId);
		return;
	}
	const preferred = preferredWorkerDeviceId === undefined
		? undefined
		: WorkerPlacement.reusableWorker(deviceRegistry, preferredWorkerDeviceId, stage, { isPreviousAssignmentReleased });
	const device = preferred ?? (retryReason === undefined
		? deviceRegistry.findWorker(stage, excluded) ?? deviceRegistry.findWorker(stage)
		: deviceRegistry.findWorker(stage, excluded));
	if (!device) {
		taskStore.update(taskId, { state: "queued", assignment: undefined });
		broadcastTask(taskId);
		return;
	}
	if (existing.assignment) {
		releaseWorkerAssignment(existing.assignment.workerDeviceId);
		// A worker no longer learns that its assignment was superseded from a task
		// snapshot, because task updates are not sent to workers any more. Tell the
		// superseded worker directly, so it can drop any state it holds for the task.
		const supersededSocket = socketMap.get(existing.assignment.workerDeviceId);
		if (supersededSocket) send(supersededSocket, { type: "stage.cancel", taskId, assignmentId: existing.assignment.assignmentId, attempt: existing.assignment.attempt, reason: retryReason ?? "assignment_superseded" }, counterpartFor(existing.assignment.workerDeviceId));
	}
	const task = taskStore.assign(taskId, device.deviceId, stage, value, retryReason, stagePolicyResolver.resolve(existing, stage).leaseMs);
	occupyWorkerAssignment(device.deviceId);
	const socket = socketMap.get(device.deviceId);
	if (socket) {
		// The worker is told which computation to run and which position in its pipeline this
		// stage occupies, so it never has to recognise the stage name to know what to do.
		const specification = stagePolicyResolver.stageSpecification(existing, stage);
		send(socket, {
			type: "stage.assign",
			taskId,
			assignmentId: task.assignment!.assignmentId,
			attempt: task.assignment!.attempt,
			stage,
			computation: specification?.computation ?? stage,
			stageIndex: Math.max(0, (existing.pipelineStages ?? []).indexOf(stage)),
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
		if (stage === undefined) continue;
		// A task waits in the queue when no worker advertised the stage that comes next. If that
		// stage keeps state in the memory of one device, the wait must not be ended by handing
		// the stage to whichever worker connected first: only the device holding the state can
		// carry the stage on. The task holds no assignment while it is queued, so nothing is
		// discounted from the preferred worker's assignment counter.
		const preferredWorkerDeviceId = WorkerPlacement.preferredWorkerDeviceId(task, stage, stagePolicyResolver.resolve(task, stage));
		assign(task.taskId, task.completedStages.at(-1)?.value ?? StagePayloadFactory.initial(task.input), stage, { preferredWorkerDeviceId, isPreviousAssignmentReleased: true });
	}
}

/**
 * Retries every assignment whose lease has run out without the worker extending it.
 *
 * A stage that keeps state between assignments is retried on the same worker rather than
 * away from it. Moving such a stage elsewhere throws away the state the previous worker
 * holds — for a language-model shard, its key-value cache — at exactly the moment the model
 * is slow, so the retry is more likely to be slow again than the attempt it replaced. A
 * stage that keeps no state is still retried away from the worker that missed its lease.
 */
function recoverAssignments(): void {
	for (const task of taskStore.list()) {
		const assignment = task.assignment;
		if (!assignment || Date.parse(assignment.leaseUntil) > Date.now()) continue;
		const policy = stagePolicyResolver.resolve(task, assignment.stage);
		if (policy.prefersSameWorkerOnRetry) {
			assign(task.taskId, assignment.value, assignment.stage, { retryReason: "lease_expired", preferredWorkerDeviceId: assignment.workerDeviceId });
			continue;
		}
		assign(task.taskId, assignment.value, assignment.stage, { excluded: [assignment.workerDeviceId], retryReason: "lease_expired" });
	}
}

function recoverWorkerAssignments(deviceId: string): void {
	for (const task of taskStore.list()) {
		const assignment = task.assignment;
		if (assignment?.workerDeviceId === deviceId) assign(task.taskId, assignment.value, assignment.stage, { excluded: [deviceId], retryReason: "worker_disconnected" });
	}
}

/**
 * Broadcasts the slim projection of a task on every revision, when the task exists.
 *
 * The projection carries only what changes as a task advances, so its size does not
 * grow with the number of stages the task runs. A recipient that needs the task input,
 * the completed stage values, or the change log asks for them with `task.get`,
 * `task.resync`, or `task.history`.
 *
 * The assigned worker is deliberately not a recipient. A worker sees only its own
 * stage, which `stage.assign` already carries in full. Sending the whole task to a
 * worker would disclose the original task input, the identity of the consumer that
 * submitted the task, and the results of every other stage.
 *
 * @param taskId - The task identifier to broadcast.
 */
function broadcastTask(taskId: string): void {
	const task = taskStore.get(taskId);
	if (!task) return;
	const update = TaskProjection.update(task);
	const recipients = new Set<string>([task.consumerDeviceId, ...(taskObserverDeviceIds.get(taskId) ?? [])]);
	for (const recipient of recipients) {
		const recipientSocket = socketMap.get(recipient);
		if (recipientSocket) send(recipientSocket, { type: "task.updated", update }, counterpartFor(recipient));
	}
}

/**
 * Reports whether a connection is allowed to read a whole task.
 *
 * Holding a stage assignment does not grant this permission: a worker sees only the
 * stage it was assigned, never the whole task.
 *
 * @param deviceId - The identifier of the connection asking to read the task.
 * @param taskId - The task identifier being read.
 * @returns `true` when the connection owns the task or was granted observation of it.
 */
function mayReadTask(deviceId: string, taskId: string): boolean {
	const task = taskStore.get(taskId);
	return task?.consumerDeviceId === deviceId || taskObserverDeviceIds.get(taskId)?.has(deviceId) === true;
}

/**
 * Handles one validated client message for a connected device.
 *
 * @param socket - The WebSocket that sent the message.
 * @param deviceId - The identifier assigned to the WebSocket connection.
 * @param message - The client message to process.
 */
function handle(socket: WebSocket, deviceId: string, message: ClientMessage, requestFrameId: string): void {
	// The session expiry the gateway advertises is checked here, on every message, rather than
	// only at the moment a connection authenticates. An expired session is refused until the
	// client authenticates again on the same connection; the connection is never closed for it.
	const currentSession = sessionRegistry.active(deviceId);
	if (message.type !== "authenticate" && currentSession === undefined) {
		sendError(socket, requestFrameId, counterpartFor(deviceId), "AUTHENTICATION_REQUIRED", "Authenticate before using the protocol", { retryable: true });
		return;
	}
	if (message.type === "observe") {
		observerDeviceIds.add(deviceId);
		// An observer connection exists to watch the cluster, so observing implies a
		// device membership subscription and no separate "devices.subscribe" is needed.
		deviceSubscriberIds.add(deviceId);
		send(socket, { type: "devices", devices: connectedDevices(), revision: deviceRegistry.membershipRevision() }, counterpartFor(deviceId), requestFrameId);
		return;
	}
	if (message.type === "devices.subscribe") {
		deviceSubscriberIds.add(deviceId);
		send(socket, { type: "devices", devices: connectedDevices(), revision: deviceRegistry.membershipRevision() }, counterpartFor(deviceId), requestFrameId);
		return;
	}
	if (message.type === "devices.unsubscribe") {
		deviceSubscriberIds.delete(deviceId);
		return;
	}
	if (message.type === "authenticate") {
		if (message.token !== options.authToken) { sendError(socket, requestFrameId, counterpartFor(deviceId), "AUTHENTICATION_REQUIRED", "Credentials were rejected", { retryable: false }); return; }
		// Authenticating again on a connection that already has a session simply replaces it,
		// which is how a client renews before or after its session runs out.
		const session = sessionRegistry.open(deviceId, message.token);
		send(socket, { type: "authenticated", principal: session.principal, expiresAt: new Date(session.expiresAt).toISOString() }, counterpartFor(deviceId), requestFrameId);
		return;
	}
	// Answered before registration on purpose: a worker asks which pipelines the gateway has
	// loaded so it can decide which stages to advertise, and that decision has to be made
	// before it registers. A pipeline specification carries no task data.
	if (message.type === "pipelines.get") { send(socket, { type: "pipelines", pipelines: pipelineRegistry.list().filter((specification) => specification.retired !== true) }, counterpartFor(deviceId), requestFrameId); return; }
	if (message.type === "register") {
		// The pipeline registry is the authority on which stage names exist. The shared
		// protocol package only checks the shape of a stage name, so a worker advertising a
		// stage no loaded pipeline defines is told so here, rather than registering
		// successfully and then silently never receiving work.
		const undefinedStageNames = (message.stageNames ?? []).filter((stageName) => pipelineRegistry.definesStage(stageName) === false);
		if (message.role === "worker" && undefinedStageNames.length > 0) {
			sendError(socket, requestFrameId, counterpartFor(deviceId), "VALIDATION", "No loaded pipeline defines these stages", { retryable: false, details: { undefinedStageNames, definedStageNames: pipelineRegistry.stageNames() } });
			return;
		}
		const existingDevice = message.role === "worker"
			? deviceRegistry.findByName(message.name, "worker")
			: undefined;
		if (existingDevice && existingDevice.deviceId !== deviceId) {
			// The replaced device is announced as having left. Removing it quietly left every
			// dashboard showing it next to the connection that replaced it, for as long as that
			// page stayed open, because the removal was the only thing that would have taken it
			// off the list (see https://github.com/webai-at-home/webai-at-home/issues/58).
			publishDevice(deviceRegistry.remove(existingDevice.deviceId));
			const existingSocket = socketMap.get(existingDevice.deviceId);
			socketMap.delete(existingDevice.deviceId);
			existingSocket?.close(1000, "Replaced by a newer connection with the same worker name");
		}
		const device: Device = {
			deviceId,
			name: message.name,
			deviceRole: message.role,
			// A worker that names no stages is taken to run every stage the loaded pipelines
			// define, rather than a list of stage names written into the gateway.
			stageNames: message.role === "worker"
				? (message.stageNames ?? pipelineRegistry.stageNames())
				: [],
			connectedAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString(),
			principal: currentSession!.principal,
			...(message.role === "worker" ? { workerState: message.ready === false ? "draining" as const : "ready" as const, ready: message.ready ?? true, maxConcurrentAssignments: message.maxConcurrentAssignments ?? 1, activeAssignments: 0 } : {}),
		};
		const change = deviceRegistry.add(device);
		send(socket, {
			type: "registered",
			deviceId,
		}, counterpartFor(deviceId, message), requestFrameId);
		publishDevice(change);
		scheduleQueuedTasks();
		return;
	}
	if (!deviceRegistry.get(deviceId)) {
		sendError(socket, requestFrameId, counterpartFor(deviceId), "NOT_REGISTERED", "Register before sending this message");
		return;
	}
	const activeDevice = deviceRegistry.get(deviceId)!;
	deviceRegistry.add({ ...activeDevice, lastSeenAt: new Date().toISOString() });

	if (message.type === "task.observe" || message.type === "task.unobserve" || message.type === "task.resync") {
		const task = taskStore.get(message.taskId);
		if (!task) { sendError(socket, requestFrameId, counterpartFor(deviceId), "TASK_NOT_FOUND", "Task was not found", { taskId: message.taskId }); return; }
		if (message.type === "task.observe") {
			const requester = deviceRegistry.get(deviceId);
			if (requester?.deviceRole !== "consumer" || (task.consumerDeviceId !== deviceId && !taskObserverDeviceIds.get(task.taskId)?.has(deviceId))) { sendError(socket, requestFrameId, counterpartFor(deviceId), "AUTHORISATION", "Task observation requires an owner grant", { taskId: task.taskId }); return; }
			const observers = taskObserverDeviceIds.get(task.taskId) ?? new Set<string>();
			observers.add(deviceId); taskObserverDeviceIds.set(task.taskId, observers);
		}
		if (message.type === "task.resync" && mayReadTask(deviceId, task.taskId) === false) { sendError(socket, requestFrameId, counterpartFor(deviceId), "AUTHORISATION", "This connection is not allowed to read the task", { taskId: task.taskId }); return; }
		if (message.type === "task.unobserve") taskObserverDeviceIds.get(task.taskId)?.delete(deviceId);
		if (message.type !== "task.unobserve") send(socket, { type: "task.snapshot", task: TaskProjection.snapshot(task) }, counterpartFor(deviceId), requestFrameId);
		return;
	}
	if (message.type === "task.history") {
		const task = taskStore.get(message.taskId);
		if (!task) { sendError(socket, requestFrameId, counterpartFor(deviceId), "TASK_NOT_FOUND", "Task was not found", { taskId: message.taskId }); return; }
		if (mayReadTask(deviceId, task.taskId) === false) { sendError(socket, requestFrameId, counterpartFor(deviceId), "AUTHORISATION", "This connection is not allowed to read the task", { taskId: task.taskId }); return; }
		send(socket, { type: "task.history", taskId: task.taskId, events: task.events }, counterpartFor(deviceId), requestFrameId);
		return;
	}
	if (message.type === "task.observer.grant" || message.type === "task.observer.revoke") {
		const task = taskStore.get(message.taskId);
		if (!task) { sendError(socket, requestFrameId, counterpartFor(deviceId), "TASK_NOT_FOUND", "Task was not found", { taskId: message.taskId }); return; }
		if (task.consumerDeviceId !== deviceId) { sendError(socket, requestFrameId, counterpartFor(deviceId), "AUTHORISATION", "Only the task owner may manage observers", { taskId: task.taskId }); return; }
		const observer = deviceRegistry.get(message.consumerDeviceId);
		if (!observer || observer.deviceRole !== "consumer") { sendError(socket, requestFrameId, counterpartFor(deviceId), "VALIDATION", "An observer must be a connected consumer", { taskId: task.taskId }); return; }
		const observers = taskObserverDeviceIds.get(task.taskId) ?? new Set<string>();
		if (message.type === "task.observer.grant") observers.add(message.consumerDeviceId); else observers.delete(message.consumerDeviceId);
		taskObserverDeviceIds.set(task.taskId, observers);
		return;
	}
	if (message.type === "devices.resync") { send(socket, { type: "devices", devices: connectedDevices(), revision: deviceRegistry.membershipRevision() }, counterpartFor(deviceId), requestFrameId); return; }

	if (message.type === "task.submit") {
		const device = deviceRegistry.get(deviceId);
		if (device?.deviceRole !== "consumer") {
			send(socket, {
				type: "error",
				code: "CONSUMER_REQUIRED",
				message: "Only consumer browser tabs may submit tasks",
				requestId: message.requestId,
			}, counterpartFor(deviceId), requestFrameId);
			return;
		}
		const existingTask = taskStore.findByRequest(deviceId, message.requestId);
		if (existingTask) {
			if (JSON.stringify(existingTask.input) !== JSON.stringify(message.input)) {
				send(socket, { type: "error", code: "REQUEST_ID_CONFLICT", message: "requestId was already used with different task contents", requestId: message.requestId, taskId: existingTask.taskId }, counterpartFor(deviceId), requestFrameId);
				return;
			}
			send(socket, { type: "task.accepted", requestId: message.requestId, task: TaskProjection.snapshot(existingTask) }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		// Read from the live session rather than from whatever principal was recorded when this
		// connection registered, so the limit always applies to whoever is authenticated now.
		const principal = currentSession!.principal;
		const activeTaskCount = taskStore.list().filter((candidate) => candidate.consumerPrincipal === principal && !["completed", "failed", "cancelled"].includes(candidate.state)).length;
		if (activeTaskCount >= maximumTasksPerPrincipal) { sendError(socket, requestFrameId, counterpartFor(deviceId), "RATE_LIMITED", "The principal has reached its active-task limit", { requestId: message.requestId, retryable: true, details: { limit: maximumTasksPerPrincipal } }); return; }
		// Every task now runs a pipeline, including the formula and language-model ones. The
		// stage sequence is data the task carries rather than a sequence built into the
		// gateway, so a task whose pipeline is missing cannot be advanced at all.
		const pipeline = pipelineRegistry.select(message.input, message.pipelineId, message.pipelineVersion);
		if (!pipeline) { sendError(socket, requestFrameId, counterpartFor(deviceId), "NO_COMPATIBLE_WORKER", "No active compatible pipeline specification exists", { requestId: message.requestId, retryable: false }); return; }
		const task = taskStore.create(message.input, deviceId, message.requestId, principal, {
			pipelineId: pipeline.pipelineId,
			pipelineVersion: pipeline.version,
			pipelineStages: pipeline.stages.map((stage) => stage.name),
			...(pipeline.repeatsUntilDone === true ? { pipelineRepeatsUntilDone: true } : {}),
		});
		send(socket, {
			type: "task.accepted",
			requestId: message.requestId,
			task: TaskProjection.snapshot(task),
		}, counterpartFor(deviceId), requestFrameId);
		const stage = TaskStore.nextStage(task);
		if (stage) assign(task.taskId, StagePayloadFactory.initial(message.input), stage);
		return;
	}

	if (message.type === "task.get") {
		const task = taskStore.get(message.taskId);
		if (task && mayReadTask(deviceId, task.taskId)) {
			send(socket, {
				type: "task.snapshot",
				task: TaskProjection.snapshot(task),
			}, counterpartFor(deviceId), requestFrameId);
		} else if (task) {
			sendError(socket, requestFrameId, counterpartFor(deviceId), "AUTHORISATION", "This connection is not allowed to read the task", { taskId: message.taskId });
		} else {
			send(socket, {
				type: "error",
				code: "TASK_NOT_FOUND",
				message: "Task was not found",
				taskId: message.taskId,
			}, counterpartFor(deviceId), requestFrameId);
		}
		return;
	}

	if (message.type === "worker.state") {
		const device = deviceRegistry.get(deviceId);
		if (!device || device.deviceRole !== "worker") {
			send(socket, { type: "error", code: "WORKER_REQUIRED", message: "Only worker browser tabs may change worker state" }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		publishDevice(deviceRegistry.add({ ...device, workerState: message.state, ready: message.state === "ready", ...(message.maxConcurrentAssignments === undefined ? {} : { maxConcurrentAssignments: message.maxConcurrentAssignments }), lastSeenAt: new Date().toISOString() }));
		if (message.state === "ready") scheduleQueuedTasks();
		return;
	}

	if (message.type === "task.cancel") {
		const task = taskStore.get(message.taskId);
		if (!task) {
			send(socket, { type: "error", code: "TASK_NOT_FOUND", message: "Task was not found", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (task.consumerDeviceId !== deviceId) {
			send(socket, { type: "error", code: "TASK_OWNER_MISMATCH", message: "Only the task owner may cancel this task", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
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

	// A worker that is still working on its stage extends the lease rather than losing the
	// assignment mid-computation. Without this, a stage that takes longer than the lease is
	// reassigned while it is still running, its eventual result is refused as stale, and the
	// work is thrown away.
	if (message.type === "stage.heartbeat") {
		const device = deviceRegistry.get(deviceId);
		const task = taskStore.get(message.taskId);
		const assignment = task?.assignment;
		if (!device || device.deviceRole !== "worker") {
			send(socket, { type: "error", code: "WORKER_REQUIRED", message: "Only worker browser tabs may extend an assignment lease" }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		// The gateway refuses to extend a lease for an assignment that is no longer current,
		// and says so with the same message it uses to withdraw an assignment, so the worker
		// stops work and drops any state it holds rather than finishing work nobody wants.
		if (!task || !assignment || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt || assignment.workerDeviceId !== deviceId) {
			send(socket, { type: "stage.cancel", taskId: message.taskId, assignmentId: message.assignmentId, attempt: message.attempt, reason: "assignment_superseded" }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		const leaseUntil = taskStore.renewLease(task.taskId, stagePolicyResolver.resolve(task, assignment.stage).leaseMs);
		if (leaseUntil === undefined) return;
		send(socket, { type: "stage.lease.extended", taskId: task.taskId, assignmentId: assignment.assignmentId, attempt: assignment.attempt, leaseUntil }, counterpartFor(deviceId), requestFrameId);
		return;
	}

	if (message.type === "stage.accepted" || message.type === "stage.relinquish") {
		const device = deviceRegistry.get(deviceId);
		const task = taskStore.get(message.taskId);
		const assignment = task?.assignment;
		if (!device || device.deviceRole !== "worker") {
			send(socket, { type: "error", code: "WORKER_REQUIRED", message: "Only worker browser tabs may update assignments" }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (!assignment || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt || assignment.workerDeviceId !== deviceId) {
			send(socket, { type: "error", code: "STALE_ASSIGNMENT", message: "The stage assignment is no longer current", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (message.type === "stage.accepted") {
			taskStore.acceptAssignment(task.taskId);
			broadcastTask(task.taskId);
		} else {
			assign(task.taskId, assignment.value, assignment.stage, { excluded: [deviceId], retryReason: "worker_relinquished" });
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
			}, counterpartFor(deviceId), requestFrameId);
			return;
		}
		const task = taskStore.get(message.taskId);
		if (!task) {
			send(socket, { type: "error", code: "TASK_NOT_FOUND", message: "Task was not found", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		const assignment = task.assignment;
		if (!assignment || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt) {
			if (task.acknowledgedAssignmentIds?.includes(message.assignmentId)) {
				send(socket, { type: "stage.result.accepted", taskId: task.taskId, assignmentId: message.assignmentId, attempt: message.attempt, revision: task.revision, status: task.state === "completed" ? "completed" : "assigned" }, counterpartFor(deviceId), requestFrameId);
				return;
			}
			send(socket, {
				type: "error",
				code: "STALE_ASSIGNMENT",
				message: "The stage assignment is no longer current",
				taskId: message.taskId,
			}, counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (assignment.workerDeviceId !== deviceId) {
			send(socket, { type: "error", code: "ASSIGNMENT_OWNER_MISMATCH", message: "Only the assigned worker may return this stage result", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (assignment.stage !== message.stage) {
			send(socket, { type: "error", code: "ASSIGNMENT_STAGE_MISMATCH", message: "The stage result does not match the current assignment", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (task.state !== "running") {
			send(socket, { type: "error", code: "ASSIGNMENT_NOT_ACCEPTED", message: "A stage assignment must be accepted before returning a result", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		const updated = taskStore.addStage(task.taskId, {
			name: message.stage,
			value: message.value,
		}, message.assignmentId);
		releaseWorkerAssignment(deviceId);
		const upcoming = TaskStore.nextStage(updated);
		if (upcoming) {
			// A stage that keeps state in the memory of the device running it must be placed back
			// on the device holding that state: a language-model shard needs the key-value cache
			// and hand-off tensors that device holds, and a built-in language-model stage needs
			// the generation it is holding open. Which device that is comes from the task's own
			// record of which device ran each stage, falling back to the device that just
			// finished. A stage that keeps no such state is instead preferably moved to a
			// different device, to demonstrate several workers cooperating on one task. Each
			// stage states which of the two it is, so no task type is named here.
			const policy = stagePolicyResolver.resolve(updated, upcoming);
			assign(updated.taskId, message.value, upcoming, {
				excluded: policy.prefersSameWorkerOnRetry ? [] : [deviceId],
				preferredWorkerDeviceId: WorkerPlacement.preferredWorkerDeviceId(updated, upcoming, policy, deviceId),
				// The assignment this result completes was released just above, so the preferred
				// worker's assignment counter is already correct and nothing may be discounted
				// from it. Discounting one here would let that worker hold one assignment more
				// than its own maxConcurrentAssignments allows.
				isPreviousAssignmentReleased: true,
			});
		} else {
			const completed = taskStore.update(updated.taskId, {
				state: "completed",
				result: message.value,
			});
			broadcastTask(updated.taskId);
			send(socket, { type: "stage.result.accepted", taskId: completed.taskId, assignmentId: message.assignmentId, attempt: message.attempt, revision: completed.revision, status: "completed" }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		const assigned = taskStore.get(updated.taskId)!;
		send(socket, { type: "stage.result.accepted", taskId: assigned.taskId, assignmentId: message.assignmentId, attempt: message.attempt, revision: assigned.revision, status: "assigned" }, counterpartFor(deviceId), requestFrameId);
		return;
	}

	if (message.type === "stage.failed") {
		const device = deviceRegistry.get(deviceId);
		if (!device || device.deviceRole !== "worker") {
			send(socket, {
				type: "error",
				code: "WORKER_REQUIRED",
				message: "Only worker browser tabs may fail a stage",
			}, counterpartFor(deviceId), requestFrameId);
			return;
		}
		const task = taskStore.get(message.taskId);
		if (!task) {
			send(socket, { type: "error", code: "TASK_NOT_FOUND", message: "Task was not found", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		const assignment = task.assignment;
		if (!assignment || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt) {
			send(socket, { type: "error", code: "STALE_ASSIGNMENT", message: "The stage assignment is no longer current", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (assignment.workerDeviceId !== deviceId) {
			send(socket, { type: "error", code: "ASSIGNMENT_OWNER_MISMATCH", message: "Only the assigned worker may fail this stage", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (assignment.stage !== message.stage) {
			send(socket, { type: "error", code: "ASSIGNMENT_STAGE_MISMATCH", message: "The stage failure does not match the current assignment", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (task.state !== "running") {
			send(socket, { type: "error", code: "ASSIGNMENT_NOT_ACCEPTED", message: "A stage assignment must be accepted before failing", taskId: message.taskId }, counterpartFor(deviceId), requestFrameId);
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
	"/monitor": "monitor/index.html",
	"/debug": "debug/index.html",
	"/debug_iframe": "debug_iframe/index.html",
	"/debug_iframe_dev_formula": "debug_iframe_dev_formula/index.html",
	"/debug_iframe_llm_qwen3_0_6b_sharded": "debug_iframe_llm_qwen3_0_6b_sharded/index.html",
	"/debug_iframe_llm_gemma_nano_chrome_full": "debug_iframe_llm_gemma_nano_chrome_full/index.html",
};
const assetContentTypeByExtension: Record<string, string> = {
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
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

/**
 * Allows a worker browser page served from a different origin to post its diagnostics.
 *
 * The worker page is normally served by its own development server on another port, so a
 * report is a cross-origin request. A JSON post also carries a `content-type` the browser
 * treats as non-simple, so the browser asks permission with an `OPTIONS` request first and
 * refuses to send the report at all unless that permission is granted here.
 *
 * Any origin is allowed because a worker may legitimately run on any host. What actually
 * guards the endpoint is the bearer token and the requirement that the device already hold
 * an authenticated connection, not the origin the report came from.
 *
 * @param response - The HTTP response to set the headers on.
 */
function setDiagnosticsCorsHeaders(response: ServerResponse): void {
	response.setHeader("access-control-allow-origin", "*");
	response.setHeader("access-control-allow-methods", "POST, OPTIONS");
	response.setHeader("access-control-allow-headers", "authorization, content-type");
	response.setHeader("access-control-max-age", "86400");
}

/**
 * Answers a diagnostics request with a JSON body and the headers that let a browser read it.
 *
 * @param response - The HTTP response to write to.
 * @param statusCode - The HTTP status code to answer with.
 * @param body - The object to send as the response body.
 */
function endDiagnosticsResponse(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
	setDiagnosticsCorsHeaders(response);
	response.statusCode = statusCode;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(body));
}

/**
 * Reads a request body, refusing anything past the diagnostics size limit.
 *
 * The limit is enforced while the body arrives rather than after it, so an oversized report
 * is never fully buffered in memory.
 *
 * @param request - The incoming HTTP request.
 * @returns The body as text, or undefined when it exceeded the limit.
 */
function readDiagnosticsBody(request: IncomingMessage): Promise<string | undefined> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		request.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes > maximumDiagnosticsRequestBytes) {
				// Stop collecting, but leave the connection alone: the caller still has to write
				// the refusal, and destroying the connection here would reach the worker as a
				// connection reset rather than as an answer explaining what was wrong.
				chunks.length = 0;
				resolve(undefined);
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", () => resolve(undefined));
	});
}

/**
 * Records a batch of diagnostic entries reported by a worker browser page over HTTP.
 *
 * Diagnostics travel here rather than over the WebSocket connection that carries
 * scheduling, so that a worker reporting heavily cannot delay stage assignment or result
 * collection for anyone (see https://github.com/webai-at-home/webai-at-home/issues/50).
 *
 * @param request - The incoming HTTP request.
 * @param response - The HTTP response to answer with.
 */
async function handleDiagnosticsReport(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const bearerToken = (request.headers.authorization ?? "").replace(/^Bearer /, "");
	if (bearerToken !== options.authToken) {
		endDiagnosticsResponse(response, 401, { error: "Credentials were rejected" });
		return;
	}

	const bodyText = await readDiagnosticsBody(request);
	if (bodyText === undefined) {
		// The rest of the oversized body is still arriving. Answer first, then close the
		// connection rather than reading the remainder, so the sender learns why it was
		// refused and the gateway never buffers the whole thing.
		response.setHeader("connection", "close");
		response.once("finish", () => request.destroy());
		endDiagnosticsResponse(response, 413, { error: `A diagnostics report may not exceed ${maximumDiagnosticsRequestBytes} bytes` });
		return;
	}

	let json: unknown;
	try {
		json = JSON.parse(bodyText);
	} catch {
		endDiagnosticsResponse(response, 400, { error: "A diagnostics report must be valid JSON" });
		return;
	}

	// Validated against a schema rather than accepted as unknown, which is what the relay
	// over the scheduling connection used to do.
	const parsed = DiagnosticsBatchSchema.safeParse(json);
	if (parsed.success === false) {
		endDiagnosticsResponse(response, 400, { error: "A diagnostics report did not match the expected shape", details: parsed.error.issues.slice(0, 10) });
		return;
	}

	// A valid token is not enough on its own: the report must name a device that currently
	// holds an authenticated connection, so a leaked token cannot be used to write log files
	// for devices that were never here.
	const batch = parsed.data;
	if (sessionRegistry.active(batch.deviceId) === undefined) {
		endDiagnosticsResponse(response, 403, { error: "That device does not hold an authenticated connection" });
		return;
	}

	const limit = diagnosticsRateLimiter.accept(batch.deviceId, batch.entries.length);
	if (limit.isAccepted === false) {
		response.setHeader("retry-after", String(Math.ceil(limit.retryAfterMs / 1000)));
		endDiagnosticsResponse(response, 429, { error: "That device has reported too many diagnostic entries", retryAfterMs: limit.retryAfterMs });
		return;
	}

	const logger = workerMessageLogger(batch.deviceId);
	for (const entry of batch.entries) {
		// The report carries no message body, because the gateway is the other end of every
		// connection this worker has and so already recorded the body itself. What is written
		// here is the worker's own view of the timing, joined to the gateway's own record
		// through the frame identifier.
		logger.log(
			entry.direction,
			{ role: "gateway" },
			entry.messageType,
			{ type: entry.messageType },
			entry.timestamp,
			{ id: entry.messageId },
		);
	}
	endDiagnosticsResponse(response, 202, { recorded: batch.entries.length, remaining: limit.remaining });
}

const httpServer = createHttpServer((request, response) => {
	const pathname = new URL(
		request.url ?? "/",
		`http://${request.headers.host ?? "localhost"}`,
	).pathname;

	// Handled before anything else so the route behaves the same in development and in
	// production. In development every unmatched path falls through to Vite's middleware,
	// which adds permissive cross-origin headers of its own, so an endpoint left to that
	// fallthrough would appear to work in development and then be blocked by the browser in
	// production, where there is no Vite.
	if (pathname === "/diagnostics") {
		if (request.method === "OPTIONS") {
			setDiagnosticsCorsHeaders(response);
			response.statusCode = 204;
			response.end();
			return;
		}
		if (request.method !== "POST") {
			endDiagnosticsResponse(response, 405, { error: "A diagnostics report must be sent with POST" });
			return;
		}
		handleDiagnosticsReport(request, response).catch((error: unknown) => {
			console.error(error);
			endDiagnosticsResponse(response, 500, { error: "The diagnostics report could not be recorded" });
		});
		return;
	}

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
			const received: unknown = JSON.parse(rawBuffer.toString());
			// A peer built before the wrapper existed sends the message on its own. Say what is
			// now required and which versions are accepted, instead of a bare complaint that
			// the message did not validate.
			if (Envelope.isUnwrappedMessage(received)) {
				send(socket, { type: "error", code: "UNSUPPORTED", message: `This gateway speaks protocol version ${protocolVersion}, in which every message travels inside a wrapper carrying v, id, ts, and body`, details: { supportedProtocolVersions } }, counterpartFor(deviceId));
				return;
			}
			const parsed = ClientEnvelopeSchema.safeParse(received);
			if (!parsed.success) {
				send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Message does not match the supported protocol" }, counterpartFor(deviceId));
				return;
			}
			const frame = parsed.data;
			// The version is checked on every frame, which means it is checked on "authenticate",
			// the first frame a connection sends. A peer therefore learns straight away whether
			// it can talk to this gateway.
			if (Envelope.supportsVersion(frame.v) === false) {
				sendError(socket, frame.id, counterpartFor(deviceId), "UNSUPPORTED", `This gateway does not speak protocol version ${frame.v}`, { retryable: false, details: { supportedProtocolVersions } });
				return;
			}
			const message = frame.body;
			if (message.type !== "observe") gatewayMessageLogger.log("received", counterpartFor(deviceId, message), message.type, message, frame.ts, frame);
			handle(socket, deviceId, message, frame.id);
		} catch {
			send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Message is not valid JSON" }, counterpartFor(deviceId));
		}
	});
	socket.on("close", () => {
		socketMap.delete(deviceId);
		observerDeviceIds.delete(deviceId);
		deviceSubscriberIds.delete(deviceId);
		for (const observers of taskObserverDeviceIds.values()) observers.delete(deviceId);
		sessionRegistry.close(deviceId);
		diagnosticsRateLimiter.forget(deviceId);
		// "device.left" already tells subscribers exactly what changed, so the full device
		// list is not sent as well.
		publishDevice(deviceRegistry.remove(deviceId));
		recoverWorkerAssignments(deviceId);
	});
});
// A stage may declare a lease shorter than the gateway's --lease-ms default, so the sweep
// that notices an expired lease runs at least as often as the shortest lease any registered
// stage states. Sweeping less often than that would leave a short lease unnoticed for longer
// than it lasts.
const shortestStageLeaseMs = Math.min(
	Number(options.leaseMs),
	...pipelineRegistry.list().flatMap((specification) => specification.stages.map((stage) => stage.leaseMs ?? Number(options.leaseMs))),
);
const recoveryTimer = setInterval(() => {
	recoverAssignments();
	scheduleQueuedTasks();
}, Math.max(100, Math.min(shortestStageLeaseMs, Number(options.submissionTimeoutMs))));
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
	if (deviceActivityTimer !== undefined) clearTimeout(deviceActivityTimer);
	if (viteDevServer) await viteDevServer.close();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
