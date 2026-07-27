/** Keep this browser script as a module so its declarations stay local to the page. */
export { };

import { CapFormulaHelper, type StageName } from "./cap_formula_helper";

/** A message received from the central server. */
type ServerMessage = {
	/** The message category. */
	type: string;
	/** The task identifier for a stage message. */
	taskId?: string;
	/** The formula stage for a stage message. */
	stage?: StageName;
	/** The numeric value for a stage message. */
	value?: number;
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
	nameInputEl.value = `browser-volunteer-${crypto.randomUUID().slice(0, 8)}`;

	/** Opens a WebSocket connection when the connect button is clicked. */
	connectButtonEl.addEventListener("click", (): void => {
		if (socket && socket.readyState !== WebSocket.CLOSED) return;
		socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
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
			socket?.send(JSON.stringify({ type: "register", role: "volunteer", name: nameInputEl.value, capabilities: CapFormulaHelper.capabilities }));
		});
		/** Handles messages received from the central server. */
		socket.addEventListener("message", (event: MessageEvent): void => {
			/** The decoded server message. */
			const message: ServerMessage = JSON.parse(event.data as string) as ServerMessage;
			log(message);
			if (message.type !== "stage.assign" || message.stage === undefined || message.value === undefined || message.taskId === undefined) return;
			/** The result produced by this volunteer browser for the assigned stage. */
			const value: number = CapFormulaHelper.compute(message.stage, message.value);
			socket?.send(JSON.stringify({ type: "stage.result", taskId: message.taskId, stage: message.stage, value }));
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
		if (socket) socket.close(1000, "Disconnected by volunteer");
	});
})();
