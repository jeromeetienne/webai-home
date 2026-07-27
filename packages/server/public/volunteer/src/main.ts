/** @typedef {"multiply" | "add"} StageName */

/**
 * @typedef {Object} ServerMessage
 * @property {string} type
 * @property {string} [deviceId]
 * @property {string} [taskId]
 * @property {StageName} [stage]
 * @property {number} [value]
 * @property {string} [peerId]
 */

/**
 * @param {unknown} value
 * @returns {void}
 */
const log = (value) => {
	const output = /** @type {HTMLElement} */ (document.querySelector("#log"));
	output.textContent += `${output.textContent === "No messages yet." ? "" : "\n"}${JSON.stringify(value, null, 2)}`;
};
const status = /** @type {HTMLElement} */ (document.querySelector("#status"));
const nameInput = /** @type {HTMLInputElement} */ (document.querySelector("#name"));
const connectButton = /** @type {HTMLButtonElement} */ (document.querySelector("#connect"));
const disconnectButton = /** @type {HTMLButtonElement} */ (document.querySelector("#disconnect"));
/** @type {WebSocket | undefined} */
let socket;
nameInput.value = `browser-volunteer-${crypto.randomUUID().slice(0, 8)}`;

connectButton.addEventListener("click", () => {
	if (socket && socket.readyState !== WebSocket.CLOSED) return;
	socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
	status.textContent = "Connecting";
	status.className = "badge text-bg-warning";
	connectButton.disabled = true;
	socket.addEventListener("open", () => {
		status.textContent = "Connected";
		status.className = "badge text-bg-success";
		connectButton.classList.add("d-none");
		disconnectButton.classList.remove("d-none");
		nameInput.disabled = true;
		socket?.send(JSON.stringify({ type: "register", role: "volunteer", name: nameInput.value, capabilities: ["cap_formula_multiply", "cap_formula_add"] }));
	});
	socket.addEventListener("message", (event) => {
		/** @type {ServerMessage} */
		const message = JSON.parse(event.data);
		log(message);
		if (message.type !== "stage.assign") return;
		const value = message.stage === "multiply" ? /** @type {number} */ (message.value) * 2 : /** @type {number} */ (message.value) + 7;
		socket?.send(JSON.stringify({ type: "stage.result", taskId: message.taskId, stage: message.stage, value }));
	});
	socket.addEventListener("close", () => {
		status.textContent = "Disconnected";
		status.className = "badge text-bg-danger";
		connectButton.classList.remove("d-none");
		connectButton.disabled = false;
		disconnectButton.classList.add("d-none");
		nameInput.disabled = false;
		socket = undefined;
	});
});

disconnectButton.addEventListener("click", () => {
	if (socket) socket.close(1000, "Disconnected by volunteer");
});
