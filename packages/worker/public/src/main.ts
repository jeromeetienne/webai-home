/** Keep this browser script as a module so its declarations stay local to the page. */
export { };

import { StageName, type StageName as StageNameType, type StagePayload, type ClientMessage } from "@webai/protocol";
import { StageFormulaHelper } from "./stage_formula_helper";
import { StageLlmHelper } from "./stage_llm_helper";
import { centralGatewayWebSocketUrl } from "./gateway_config";

/**
 * Reads the stages enabled for this worker browser from the page URL.
 * Repeating the parameter allows one worker browser to support multiple stages.
 * The stageNames alias keeps existing debug URLs working.
 */
export const enabledStageNamesFromUrl = (search: string): StageNameType[] => {
	const searchParams = new URLSearchParams(search);
	const requestedStageNames = [
		...searchParams.getAll("enabledStages"),
		...searchParams.getAll("stageNames"),
	];
	const validStageNames = requestedStageNames.filter((stageName): stageName is StageNameType =>
		StageName.safeParse(stageName).success,
	);
	return validStageNames.length > 0
		? [...new Set(validStageNames)]
		: [...StageFormulaHelper.stageNames, ...StageLlmHelper.stageNames];
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
 * Relays a structured log entry to the central gateway, since this browser page cannot
 * write its own log file to disk. The gateway appends it to this worker's own log file.
 *
 * @param socket The active WebSocket connection to the central gateway.
 * @param direction Whether the entry records a message sent to, or received from, the gateway.
 * @param message The client or gateway message this entry describes.
 */
const relayLogEntry = (socket: WebSocket, direction: "received" | "sent", message: { type: string }): void => {
	const logEntryMessage: ClientMessage = {
		type: "log.entry",
		direction,
		messageType: message.type,
		timestamp: new Date().toISOString(),
		payload: message,
	};
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(logEntryMessage));
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
	/** The stages this worker browser advertises to the central gateway. */
	const enabledStageNames = enabledStageNamesFromUrl(location.search);
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
	stagesEl.innerHTML = enabledStageNames.map((stageName) => `<span class="badge text-bg-light border">${escapeHtml(stageName)}</span>`).join("");
	renderEvents(events);

	/** Opens a WebSocket connection when the connect button is clicked. */
	connectButtonEl.addEventListener("click", async (): Promise<void> => {

		// Do not open a new connection if one is already open or in the process of opening.
		if (isPreparing || (socket && socket.readyState !== WebSocket.CLOSED)) return;
		isPreparing = true;
		connectButtonEl.disabled = true;
		statusEl.textContent = enabledStageNames.some((stageName) => StageLlmHelper.stageNames.includes(stageName))
			? "Loading LLM shards"
			: "Connecting";
		statusEl.className = "badge text-bg-warning";
		try {
			await StageLlmHelper.preload(enabledStageNames);
		} catch (error: unknown) {
			isPreparing = false;
			statusEl.textContent = "Shard loading failed";
			statusEl.className = "badge text-bg-danger";
			addEvent({ direction: "local", type: "worker.error", timestamp: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) });
			connectButtonEl.disabled = false;
			return;
		}
		isPreparing = false;

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
			const message: ClientMessage = { type: "authenticate", token: "development-token" };
			if (socket) relayLogEntry(socket, "sent", message);
			socket?.send(JSON.stringify(message));
			addEvent({ direction: "sent", type: message.type, timestamp: new Date().toISOString() });
		});

		/** Handles messages received from the central gateway. */
		socket.addEventListener("message", (event: MessageEvent): void => {
			/** The decoded gateway message. */
			const message: GatewayMessage = JSON.parse(event.data as string) as GatewayMessage;
			addEvent({
				direction: "received",
				type: message.type,
				timestamp: new Date().toISOString(),
				...(message.taskId ? { taskId: message.taskId } : {}),
				...(message.stage ? { stage: message.stage } : {}),
			});
			if (message.type === "authenticated" && socket) {
				const register: ClientMessage = { type: "register", role: "worker", name: nameInputEl.value, stageNames: enabledStageNames };
				relayLogEntry(socket, "sent", register);
				socket.send(JSON.stringify(register));
				return;
			}
			if (message.type === "registered") deviceIdEl.textContent = message.deviceId ?? "Not assigned";
			if (socket) relayLogEntry(socket, "received", message);
			if (message.type === "stage.cancel" && message.taskId !== undefined) {
				StageLlmHelper.clearTask(message.taskId);
				return;
			}
			if (message.type !== "stage.assign" || message.stage === undefined || message.value === undefined || message.taskId === undefined || message.assignmentId === undefined || message.attempt === undefined) return;
			/** The task identifier and stage captured for the async result below. */
			const { taskId, assignmentId, attempt, stage, value } = message;
			const acceptedMessage: ClientMessage = { type: "stage.accepted", taskId, assignmentId, attempt };
			if (socket) relayLogEntry(socket, "sent", acceptedMessage);
			socket?.send(JSON.stringify(acceptedMessage));
			/** Whether the assigned stage is one of this browser's LLM shards, as opposed to a formula stage. */
			const isLlmStage = StageLlmHelper.stageNames.includes(stage);
			/** Computes the result for the assigned stage and sends it back once ready. */
			const computeResult: Promise<StagePayload> = isLlmStage
				? StageLlmHelper.compute(stage, taskId, value as Exclude<StagePayload, number>)
				: Promise.resolve(StageFormulaHelper.compute(stage, value as number));
			computeResult
				.then((value) => {
					const resultMessage: ClientMessage = {
						type: "stage.result",
						taskId,
						assignmentId,
						attempt,
						stage,
						value
					};
					if (socket) relayLogEntry(socket, "sent", resultMessage);
					socket?.send(JSON.stringify(resultMessage));
					addEvent({ direction: "sent", type: resultMessage.type, timestamp: new Date().toISOString(), taskId, stage });
				})
				.catch((error: unknown) => {
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
					if (socket) relayLogEntry(socket, "sent", failedMessage);
					socket?.send(JSON.stringify(failedMessage));
					addEvent({ direction: "sent", type: failedMessage.type, timestamp: new Date().toISOString(), taskId, stage, message: failedMessage.error });
				});
		});

		/** Restores the disconnected state when the WebSocket closes. */
		socket.addEventListener("close", (): void => {
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
