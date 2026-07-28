/** Keep this browser script as a module so its declarations stay local to the page. */
export { };

import type { StageName, StagePayload, ClientMessage } from "@webai/protocol";
import { StageFormulaHelper } from "./stage_formula_helper";
import { StageLlmHelper } from "./stage_llm_helper";

/** A message received from the central server. */
type ServerMessage = {
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
 * Writes a value to the volunteer browser log.
 *
 * @param value The value to format and append to the log.
 */
const log = (value: unknown): void => {
	/** The log element shown on the volunteer page. */
	const output: HTMLElement = getElement("#log");
	output.textContent += `${output.textContent === "No messages yet." ? "" : "\n"}${JSON.stringify(value, null, 2)}`;
};

/**
 * Relays a structured log entry to the central server, since this browser page cannot
 * write its own log file to disk. The server appends it to this volunteer's own log file.
 *
 * @param socket The active WebSocket connection to the central server.
 * @param direction Whether the entry records a message sent to, or received from, the server.
 * @param message The client or server message this entry describes.
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

/** Starts the volunteer browser user interface. */
((): void => {
	/** The connection status element. */
	const statusEl: HTMLElement = getElement("#status");
	/** The input containing the volunteer browser name. */
	const nameInputEl: HTMLInputElement = getInput("#name");
	/** The button that opens the volunteer browser connection. */
	const connectButtonEl: HTMLButtonElement = getButton("#connect");
	/** The button that closes the volunteer browser connection. */
	const disconnectButtonEl: HTMLButtonElement = getButton("#disconnect");
	/** The active WebSocket connection, when the volunteer browser is connected. */
	let socket: WebSocket | undefined;

	// Set a random name for the volunteer browser, so multiple volunteers can be opened in the same browser without name conflicts.
	nameInputEl.value = `browser-volunteer-${crypto.randomUUID().slice(0, 8)}`;

	/** Opens a WebSocket connection when the connect button is clicked. */
	connectButtonEl.addEventListener("click", (): void => {

		// Do not open a new connection if one is already open or in the process of opening.
		if (socket && socket.readyState !== WebSocket.CLOSED) return;

		// Open a WebSocket connection to the central server.
		socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);

		// update ui
		statusEl.textContent = "Connecting";
		statusEl.className = "badge text-bg-warning";
		connectButtonEl.disabled = true;

		/** Updates the page and registers the volunteer browser after connection. */
		socket.addEventListener("open", (): void => {
			statusEl.textContent = "Connected";
			statusEl.className = "badge text-bg-success";
			connectButtonEl.classList.add("d-none");
			disconnectButtonEl.classList.remove("d-none");
			nameInputEl.disabled = true;
			const message: ClientMessage = {
				type: "register",
				role: "volunteer",
				name: nameInputEl.value,
				stageNames: [...StageFormulaHelper.stageNames, ...StageLlmHelper.stageNames]
			};
			if (socket) relayLogEntry(socket, "sent", message);
			socket?.send(JSON.stringify(message));
		});

		/** Handles messages received from the central server. */
		socket.addEventListener("message", (event: MessageEvent): void => {
			/** The decoded server message. */
			const message: ServerMessage = JSON.parse(event.data as string) as ServerMessage;
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
			socket.close(1000, "Disconnected by volunteer");
		}
	});
})();
