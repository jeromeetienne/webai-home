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
	/** The task identifier for a stage message. */
	taskId?: string;
	/** The stage for a stage message. */
	stage?: StageName;
	/** The value for a stage message: a plain number for formula stages, or an LLM payload. */
	value?: StagePayload;
};

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
const log = (value: unknown): void => {
	/** The log element shown on the worker page. */
	const output: HTMLElement = getElement("#log");
	output.textContent += `${output.textContent === "No messages yet." ? "" : "\n"}${JSON.stringify(value, null, 2)}`;
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
	/** The active WebSocket connection, when the worker browser is connected. */
	let socket: WebSocket | undefined;
	/** The stages this worker browser advertises to the central gateway. */
	const enabledStageNames = enabledStageNamesFromUrl(location.search);

	// Use the URL-provided name for embedded worker pages, and generate a random
	// name for standalone pages so multiple workers can still be opened safely.
	const workerNameFromUrl: string | null = new URLSearchParams(location.search).get("workerName");
	nameInputEl.value = workerNameFromUrl?.trim()
		? workerNameFromUrl
		: `browser-worker-${crypto.randomUUID().slice(0, 8)}`;

	/** Opens a WebSocket connection when the connect button is clicked. */
	connectButtonEl.addEventListener("click", (): void => {

		// Do not open a new connection if one is already open or in the process of opening.
		if (socket && socket.readyState !== WebSocket.CLOSED) return;

		// Open a WebSocket connection to the central gateway.
		socket = new WebSocket(centralGatewayWebSocketUrl());

		// update ui
		statusEl.textContent = "Connecting";
		statusEl.className = "badge text-bg-warning";
		connectButtonEl.disabled = true;

		/** Updates the page and registers the worker browser after connection. */
		socket.addEventListener("open", (): void => {
			statusEl.textContent = "Connected";
			statusEl.className = "badge text-bg-success";
			connectButtonEl.classList.add("d-none");
			disconnectButtonEl.classList.remove("d-none");
			nameInputEl.disabled = true;
			const message: ClientMessage = {
				type: "register",
				role: "worker",
				name: nameInputEl.value,
				stageNames: enabledStageNames,
			};
			if (socket) relayLogEntry(socket, "sent", message);
			socket?.send(JSON.stringify(message));
		});

		/** Handles messages received from the central gateway. */
		socket.addEventListener("message", (event: MessageEvent): void => {
			/** The decoded gateway message. */
			const message: GatewayMessage = JSON.parse(event.data as string) as GatewayMessage;
			log(message);
			if (socket) relayLogEntry(socket, "received", message);
			if (message.type !== "stage.assign" || message.stage === undefined || message.value === undefined || message.taskId === undefined) return;
			/** The task identifier and stage captured for the async result below. */
			const { taskId, stage, value } = message;
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
						stage,
						value
					};
					if (socket) relayLogEntry(socket, "sent", resultMessage);
					socket?.send(JSON.stringify(resultMessage));
				})
				.catch((error: unknown) => {
					// A failed LLM stage abandons the task; drop its in-memory key-value cache
					// rather than leaving it in memory for a task that will never resume.
					if (isLlmStage) StageLlmHelper.clearTask(taskId);
					const failedMessage: ClientMessage = {
						type: "stage.failed",
						taskId,
						stage,
						error: error instanceof Error ? error.message : String(error),
					};
					if (socket) relayLogEntry(socket, "sent", failedMessage);
					socket?.send(JSON.stringify(failedMessage));
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
