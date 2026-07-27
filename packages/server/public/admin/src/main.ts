export { };

type DeviceSummary = {
	role: string;
	name: string;
	capabilities: string[];
};

type ServerMessage = {
	type: string;
	devices?: DeviceSummary[];
	task?: object;
};

const getElement = (selector: string): HTMLElement => {
	const element: Element | null = document.querySelector(selector);
	if (!(element instanceof HTMLElement)) throw new Error(`Element ${selector} was not found`);
	return element;
};

((): void => {
	const statusEl: HTMLElement = getElement("#status");
	const statusBadgeEl: HTMLElement = getElement("#status-badge");
	const devicesEl: HTMLElement = getElement("#devices");
	const tasksEl: HTMLElement = getElement("#tasks");
	const socketEl: WebSocket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);

	socketEl.addEventListener("open", (): void => socketEl.send(JSON.stringify({ type: "register", role: "admin", name: "administrator" })));
	socketEl.addEventListener("message", (event: MessageEvent): void => {
		const message: ServerMessage = JSON.parse(event.data as string) as ServerMessage;
		if (message.type === "registered") {
			statusEl.textContent = "Connected to the central server.";
			statusBadgeEl.textContent = "Connected";
			statusBadgeEl.className = "badge rounded-pill text-bg-success";
		}
		if (message.type === "devices" && message.devices) {
			devicesEl.innerHTML = message.devices.filter((device: DeviceSummary) => device.role === "volunteer").map((device: DeviceSummary) => `<li>${device.name} (volunteer) — ${device.capabilities.join(", ")}</li>`).join("") || "<li>Waiting for volunteer browser tabs.</li>";
		}
		if ((message.type === "task.updated" || message.type === "task.accepted") && message.task){
			tasksEl.textContent = JSON.stringify(message.task, null, 2);
		}
	});
	socketEl.addEventListener("close", (): void => {
		statusEl.textContent = "Disconnected from the central server.";
		statusBadgeEl.textContent = "Disconnected";
		statusBadgeEl.className = "badge rounded-pill text-bg-danger";
	});
})();
