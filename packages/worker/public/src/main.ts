/** Keep this browser script as a module so its declarations stay local to the page. */
export { };

import { StageName, type StageName as StageNameType, type StagePayload, type ClientMessage } from "@webai/protocol";
import { Envelope } from "@webai/protocol/envelope";
import { StageFormulaHelper } from "./stage_formula_helper";
import { StageLlmHelper } from "./stage_llm_helper";
import { centralGatewayAuthToken, centralGatewayWebSocketUrl } from "./gateway_config";
import { DiagnosticsReporter } from "./diagnostics_reporter";

/**
 * Reads the stages the page URL restricts this worker browser to.
 * Repeating the parameter allows one worker browser to support multiple stages.
 * The stageNames alias keeps existing debug URLs working.
 *
 * An empty result means the URL asks for no particular stages, and this browser offers every
 * stage it can run.
 */
export const requestedStageNamesFromUrl = (search: string): StageNameType[] => {
	const searchParams = new URLSearchParams(search);
	const requestedStageNames = [
		...searchParams.getAll("enabledStages"),
		...searchParams.getAll("stageNames"),
	];
	const validStageNames = requestedStageNames.filter((stageName): stageName is StageNameType =>
		StageName.safeParse(stageName).success,
	);
	return [...new Set(validStageNames)];
};

/**
 * Reports whether this browser implements the computation a pipeline stage names.
 *
 * This is the only place the browser decides what it can run. It matches the computation a
 * stage names, never the stage name itself, so a pipeline the gateway loaded after this
 * browser was built can offer new stage names that reuse computations already shipped here.
 *
 * @param computation The computation named by a pipeline stage.
 * @returns `true` when one of this browser's helpers implements it.
 */
const implementsComputation = (computation: string): boolean =>
	StageFormulaHelper.implementsComputation(computation) || StageLlmHelper.implementsComputation(computation);

/**
 * Chooses the stages this browser offers to the gateway, from the pipelines the gateway has
 * loaded.
 *
 * A stage is offered when this browser implements its computation and, if the page URL named
 * particular stages, when the stage is one of those.
 *
 * @param pipelines The pipeline specifications the gateway returned.
 * @param requestedStageNames The stages the page URL restricts this browser to, if any.
 * @returns The stage names to advertise, and the language-model shard positions to preload.
 */
export const offeredStages = (
	pipelines: { stages: { name: string; computation: string }[] }[],
	requestedStageNames: readonly string[],
): { stageNames: string[]; llmShardIndexes: number[] } => {
	const stageNames: string[] = [];
	const llmShardIndexes: number[] = [];
	for (const pipeline of pipelines) {
		for (const [stageIndex, stage] of pipeline.stages.entries()) {
			if (implementsComputation(stage.computation) === false) continue;
			if (requestedStageNames.length > 0 && requestedStageNames.includes(stage.name) === false) continue;
			if (stageNames.includes(stage.name) === false) stageNames.push(stage.name);
			if (StageLlmHelper.implementsComputation(stage.computation) && llmShardIndexes.includes(stageIndex) === false) llmShardIndexes.push(stageIndex);
		}
	}
	return { stageNames, llmShardIndexes };
};

/** A message received from the central gateway. */
type GatewayMessage = {
	/** The message category. */
	type: string;
	deviceId?: string;
	/** The task identifier for a stage message. */
	taskId?: string;
	/** The durable identifier for the current stage assignment. */
	assignmentId?: string;
	/** The number of the current assignment attempt. */
	attempt?: number;
	/** The stage for a stage message. */
	stage?: StageName;
	/** The value for a stage message: a plain number for formula stages, or an LLM payload. */
	value?: StagePayload;
	/** When the assignment lease runs out, unless the worker extends it with `stage.heartbeat`. */
	leaseUntil?: string;
	/** Which computation the assigned stage needs, such as `formula_multiply` or `llm_shard`. */
	computation?: string;
	/** The assigned stage's position in its pipeline, counted from zero. */
	stageIndex?: number;
	/** The pipeline specifications the gateway has loaded, in reply to `pipelines.get`. */
	pipelines?: { stages: { name: string; computation: string }[] }[];
};

type WorkerEvent = {
	direction: "sent" | "received" | "local";
	type: string;
	timestamp: string;
	taskId?: string;
	stage?: string;
	message?: string;
};

const maximumDisplayedEvents = 10;

const escapeHtml = (value: string): string => value
	.replaceAll("&", "&amp;")
	.replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;")
	.replaceAll('"', "&quot;")
	.replaceAll("'", "&#039;");

/**
 * Finds a required HTML element.
 *
 * @param selector CSS selector for the required element.
 * @returns The matching HTML element.
 * @throws If the selector does not match an HTML element.
 */
const getElement = (selector: string): HTMLElement => {
	/** The element returned by the document query. */
	const element: Element | null = document.querySelector(selector);
	if (!(element instanceof HTMLElement)) throw new Error(`Element ${selector} was not found`);
	return element;
};

/**
 * Finds a required HTML input element.
 *
 * @param selector CSS selector for the required input element.
 * @returns The matching HTML input element.
 * @throws If the selector does not match an HTML input element.
 */
const getInput = (selector: string): HTMLInputElement => {
	/** The element returned by the document query. */
	const element: Element | null = document.querySelector(selector);
	if (!(element instanceof HTMLInputElement)) throw new Error(`Input ${selector} was not found`);
	return element;
};

/**
 * Finds a required HTML button element.
 *
 * @param selector CSS selector for the required button element.
 * @returns The matching HTML button element.
 * @throws If the selector does not match an HTML button element.
 */
const getButton = (selector: string): HTMLButtonElement => {
	/** The element returned by the document query. */
	const element: Element | null = document.querySelector(selector);
	if (!(element instanceof HTMLButtonElement)) throw new Error(`Button ${selector} was not found`);
	return element;
};

/**
 * Writes a value to the worker browser log.
 *
 * @param value The value to format and append to the log.
 */
const formatTime = (timestamp: string): string => new Date(timestamp).toLocaleTimeString();

const renderEvents = (events: WorkerEvent[]): void => {
	const output: HTMLElement = getElement("#events");
	output.innerHTML = events.length === 0
		? '<p class="text-secondary mb-0">No events yet.</p>'
		: events.slice(-maximumDisplayedEvents).reverse().map((event) => {
			const details = [event.taskId ? `Task ${event.taskId}` : "", event.stage ?? "", event.message ?? ""]
				.filter(Boolean)
				.map(escapeHtml)
				.join(" · ");
			return `<article class="event-item"><div class="d-flex justify-content-between gap-3"><strong>${escapeHtml(event.type)}</strong><time class="text-secondary">${escapeHtml(formatTime(event.timestamp))}</time></div><div class="small text-secondary">${escapeHtml(event.direction)}${details ? ` · ${details}` : ""}</div></article>`;
		}).join("");
};

/**
 * Sends a message to the central gateway and notes it for this browser's diagnostics.
 *
 * The wrapper is built once here so that the identifier the gateway will see is the same
 * identifier the diagnostic entry names, which is what lets the two records of one message
 * be joined afterwards.
 *
 * @param socket The active WebSocket connection to the central gateway.
 * @param message The client message to send.
 */
const sendToGateway = (socket: WebSocket, message: ClientMessage): void => {
	const frame = Envelope.fromClient(message);
	if (socket.readyState !== WebSocket.OPEN) return;
	socket.send(JSON.stringify(frame));
	DiagnosticsReporter.record("sent", message.type, frame.id);
};

/** The repeating timer that extends the lease of one running assignment, by assignment identifier. */
const leaseHeartbeatTimers = new Map<string, number>();

/**
 * The shortest gap allowed between two lease heartbeats, in milliseconds.
 *
 * A very short lease would otherwise make this browser send heartbeats continuously.
 */
const minimumHeartbeatIntervalMs = 1_000;

/**
 * Starts extending the lease of an assignment this browser is working on.
 *
 * The gateway takes an assignment away from a worker whose lease runs out, so a stage that
 * takes longer than its lease would be reassigned while it is still running and its
 * eventual result refused as stale. Sending `stage.heartbeat` says the worker is still
 * working, and the gateway answers with a later lease expiry.
 *
 * The heartbeat is sent three times per lease, so a single lost or late message does not
 * cost the assignment.
 *
 * @param socket The open connection to the central gateway.
 * @param assignment The task, assignment, attempt, and lease expiry from `stage.assign`.
 */
const startLeaseHeartbeat = (socket: WebSocket, assignment: { taskId: string; assignmentId: string; attempt: number; leaseUntil?: string | undefined }): void => {
	const leaseMs = assignment.leaseUntil === undefined ? Number.NaN : Date.parse(assignment.leaseUntil) - Date.now();
	const intervalMs = Number.isFinite(leaseMs) ? Math.max(minimumHeartbeatIntervalMs, Math.floor(leaseMs / 3)) : minimumHeartbeatIntervalMs;
	const timer = window.setInterval((): void => {
		if (socket.readyState !== WebSocket.OPEN) return;
		const heartbeatMessage: ClientMessage = { type: "stage.heartbeat", taskId: assignment.taskId, assignmentId: assignment.assignmentId, attempt: assignment.attempt };
		sendToGateway(socket, heartbeatMessage);
	}, intervalMs);
	leaseHeartbeatTimers.set(assignment.assignmentId, timer);
};

/**
 * Stops extending the lease of an assignment this browser is no longer working on.
 *
 * @param assignmentId The assignment whose heartbeat should stop. When it is not given,
 * every running heartbeat stops, which is what a closed connection needs.
 */
const stopLeaseHeartbeat = (assignmentId?: string): void => {
	if (assignmentId === undefined) {
		for (const timer of leaseHeartbeatTimers.values()) window.clearInterval(timer);
		leaseHeartbeatTimers.clear();
		return;
	}
	const timer = leaseHeartbeatTimers.get(assignmentId);
	if (timer === undefined) return;
	window.clearInterval(timer);
	leaseHeartbeatTimers.delete(assignmentId);
};

/** Starts the worker browser user interface. */
((): void => {
	/** The connection status element. */
	const statusEl: HTMLElement = getElement("#status");
	/** The input containing the worker browser name. */
	const nameInputEl: HTMLInputElement = getInput("#name");
	/** The button that opens the worker browser connection. */
	const connectButtonEl: HTMLButtonElement = getButton("#connect");
	/** The button that closes the worker browser connection. */
	const disconnectButtonEl: HTMLButtonElement = getButton("#disconnect");
	const workerNameEl: HTMLElement = getElement("#worker-name");
	const deviceIdEl: HTMLElement = getElement("#device-id");
	const stagesEl: HTMLElement = getElement("#stages");
	/** The active WebSocket connection, when the worker browser is connected. */
	let socket: WebSocket | undefined;
	/** Whether the gateway has accepted this worker browser's registration. */
	/** The stages the page URL restricts this worker browser to, if it names any. */
	const requestedStageNames = requestedStageNamesFromUrl(location.search);
	/**
	 * The stages this worker browser advertises, decided once the gateway has sent its
	 * pipelines. It stays empty until then, because which stage names exist is decided by the
	 * pipelines the gateway has loaded rather than by a list built into this page.
	 */
	let enabledStageNames: string[] = [];
	/** Prevents another connection attempt while enabled LLM shards are preloading. */
	let isPreparing = false;
	const events: WorkerEvent[] = [];
	const addEvent = (event: WorkerEvent): void => {
		events.push(event);
		if (events.length > maximumDisplayedEvents) events.splice(0, events.length - maximumDisplayedEvents);
		renderEvents(events);
	};

	// Use the URL-provided name for embedded worker pages, and generate a random
	// name for standalone pages so multiple workers can still be opened safely.
	const workerNameFromUrl: string | null = new URLSearchParams(location.search).get("workerName");
	nameInputEl.value = workerNameFromUrl?.trim()
		? workerNameFromUrl
		: `browser-worker-${crypto.randomUUID().slice(0, 8)}`;
	workerNameEl.textContent = nameInputEl.value;
	/** Shows the stages this worker browser currently offers. */
	const renderStages = (): void => {
		stagesEl.innerHTML = enabledStageNames.length === 0
			? '<span class="text-body-secondary">Waiting for the gateway\'s pipelines</span>'
			: enabledStageNames.map((stageName) => `<span class="badge text-bg-light border">${escapeHtml(stageName)}</span>`).join("");
	};
	renderStages();
	renderEvents(events);

	/** Opens a WebSocket connection when the connect button is clicked. */
	connectButtonEl.addEventListener("click", async (): Promise<void> => {

		// Do not open a new connection if one is already open or in the process of opening.
		if (isPreparing || (socket && socket.readyState !== WebSocket.CLOSED)) return;
		connectButtonEl.disabled = true;
		statusEl.textContent = "Connecting";
		statusEl.className = "badge text-bg-warning";

		// The shards this browser preloads depend on which stages it will offer, and that is
		// decided from the pipelines the gateway sends. So the connection opens first, and the
		// preload happens once the pipelines have arrived, just before registration.

		// Open a WebSocket connection to the central gateway.
		socket = new WebSocket(centralGatewayWebSocketUrl());

		// update ui
		statusEl.textContent = "Connecting";
		statusEl.className = "badge text-bg-warning";
		connectButtonEl.disabled = true;

		/** Authenticates the worker browser after connection. */
		socket.addEventListener("open", (): void => {
			statusEl.textContent = "Connected";
			statusEl.className = "badge text-bg-success";
			connectButtonEl.classList.add("d-none");
			disconnectButtonEl.classList.remove("d-none");
			nameInputEl.disabled = true;
			const message: ClientMessage = { type: "authenticate", token: centralGatewayAuthToken };
			if (socket) sendToGateway(socket, message);
			addEvent({ direction: "sent", type: message.type, timestamp: new Date().toISOString() });
		});

		/** Handles messages received from the central gateway. */
		socket.addEventListener("message", (event: MessageEvent): void => {
			/** The wrapper the gateway message travelled in. */
			const frame = JSON.parse(event.data as string) as { v?: number; id?: string; inReplyTo?: string; body?: GatewayMessage };
			/** The decoded gateway message. */
			const message: GatewayMessage = frame.body ?? ({ type: "error" } as GatewayMessage);
			addEvent({
				direction: "received",
				type: message.type,
				timestamp: new Date().toISOString(),
				...(message.taskId ? { taskId: message.taskId } : {}),
				...(message.stage ? { stage: message.stage } : {}),
			});
			// Ask the gateway which pipelines it has loaded before registering, so this browser
			// can offer every stage whose computation it implements, including stages of a
			// pipeline added after this browser was built.
			if (message.type === "authenticated" && socket) {
				const request: ClientMessage = { type: "pipelines.get" };
				sendToGateway(socket, request);
				addEvent({ direction: "sent", type: request.type, timestamp: new Date().toISOString() });
				return;
			}
			if (message.type === "pipelines" && socket) {
				const offered = offeredStages(message.pipelines ?? [], requestedStageNames);
				enabledStageNames = offered.stageNames;
				renderStages();
				if (offered.stageNames.length === 0) {
					statusEl.textContent = "No stage to run";
					statusEl.className = "badge text-bg-danger";
					addEvent({ direction: "local", type: "worker.error", timestamp: new Date().toISOString(), message: "No loaded pipeline has a stage this browser implements" });
					socket.close(1000, "No stage to run");
					return;
				}
				isPreparing = true;
				if (offered.llmShardIndexes.length > 0) {
					statusEl.textContent = "Loading LLM shards";
					statusEl.className = "badge text-bg-warning";
				}
				StageLlmHelper.preload(offered.llmShardIndexes)
					.then(() => {
						isPreparing = false;
						if (!socket) return;
						statusEl.textContent = "Connected";
						statusEl.className = "badge text-bg-success";
						const register: ClientMessage = { type: "register", role: "worker", name: nameInputEl.value, stageNames: enabledStageNames };
						sendToGateway(socket, register);
						addEvent({ direction: "sent", type: register.type, timestamp: new Date().toISOString() });
					})
					.catch((error: unknown) => {
						isPreparing = false;
						statusEl.textContent = "Shard loading failed";
						statusEl.className = "badge text-bg-danger";
						addEvent({ direction: "local", type: "worker.error", timestamp: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) });
						socket?.close(1000, "Shard loading failed");
					});
				return;
			}
			if (message.type === "registered") {
				deviceIdEl.textContent = message.deviceId ?? "Not assigned";
				// Reporting can only start now: the gateway names the device the report is for,
				// and it issues that name here.
				if (message.deviceId !== undefined) DiagnosticsReporter.start(message.deviceId, centralGatewayAuthToken);
			}
			DiagnosticsReporter.record("received", message.type, frame.id);
			if (message.type === "stage.cancel" && message.taskId !== undefined) {
				stopLeaseHeartbeat(message.assignmentId);
				StageLlmHelper.clearTask(message.taskId);
				return;
			}
			// The gateway answers each lease heartbeat with a later expiry. Nothing has to be
			// done with it: the assignment is still this browser's, which is the whole point.
			if (message.type === "stage.lease.extended") return;
			if (message.type !== "stage.assign" || message.stage === undefined || message.value === undefined || message.taskId === undefined || message.assignmentId === undefined || message.attempt === undefined) return;
			/** The task identifier and stage captured for the async result below. */
			const { taskId, assignmentId, attempt, stage, value } = message;
			const acceptedMessage: ClientMessage = { type: "stage.accepted", taskId, assignmentId, attempt };
			if (socket) sendToGateway(socket, acceptedMessage);
			if (socket) startLeaseHeartbeat(socket, { taskId, assignmentId, attempt, leaseUntil: message.leaseUntil });
			// The assignment says which computation to run and which position in its pipeline
			// the stage occupies. This browser never has to recognise the stage name.
			const computation = message.computation ?? "";
			/** Whether the assigned stage runs a language-model shard, as opposed to a formula computation. */
			const isLlmStage = StageLlmHelper.implementsComputation(computation);
			/** Computes the result for the assigned stage and sends it back once ready. */
			const computeResult: Promise<StagePayload> = isLlmStage
				? StageLlmHelper.compute(message.stageIndex ?? 0, taskId, value as Exclude<StagePayload, number>)
				: Promise.resolve(StageFormulaHelper.compute(computation, value as number));
			computeResult
				.then((value) => {
					stopLeaseHeartbeat(assignmentId);
					const resultMessage: ClientMessage = {
						type: "stage.result",
						taskId,
						assignmentId,
						attempt,
						stage,
						value
					};
					if (socket) sendToGateway(socket, resultMessage);
					addEvent({ direction: "sent", type: resultMessage.type, timestamp: new Date().toISOString(), taskId, stage });
				})
				.catch((error: unknown) => {
					stopLeaseHeartbeat(assignmentId);
					// A failed LLM stage abandons the task; drop its in-memory key-value cache
					// rather than leaving it in memory for a task that will never resume.
					if (isLlmStage) StageLlmHelper.clearTask(taskId);
					const failedMessage: ClientMessage = {
						type: "stage.failed",
						taskId,
						assignmentId,
						attempt,
						stage,
						error: error instanceof Error ? error.message : String(error),
					};
					if (socket) sendToGateway(socket, failedMessage);
					addEvent({ direction: "sent", type: failedMessage.type, timestamp: new Date().toISOString(), taskId, stage, message: failedMessage.error });
				});
		});

		/** Restores the disconnected state when the WebSocket closes. */
		socket.addEventListener("close", (): void => {
			stopLeaseHeartbeat();
			// Posts whatever is still buffered, so the last messages before a disconnection are
			// still recorded rather than lost with the page's state.
			DiagnosticsReporter.stop();
			statusEl.textContent = "Disconnected";
			statusEl.className = "badge text-bg-danger";
			connectButtonEl.classList.remove("d-none");
			connectButtonEl.disabled = false;
			disconnectButtonEl.classList.add("d-none");
			nameInputEl.disabled = false;
			socket = undefined;
		});
	});

	/** Closes the WebSocket connection when the disconnect button is clicked. */
	disconnectButtonEl.addEventListener("click", (): void => {
		if (socket) {
			socket.close(1000, "Disconnected by worker");
		}
	});

	// Connect automatically once the page controls and event handlers are ready.
	connectButtonEl.click();
})();
