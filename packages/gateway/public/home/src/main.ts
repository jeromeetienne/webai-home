export { };
import type { DeviceRole } from "@webai/protocol";

type DeviceSummary = {
	deviceRole: DeviceRole;
	name: string;
	stageNames: string[];
};

type GatewayMessage = {
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

	socketEl.addEventListener("open", (): void => {
		socketEl.send(JSON.stringify({ type: "observe" }));
		statusEl.textContent = "Connected to the central gateway.";
		statusBadgeEl.textContent = "Connected";
		statusBadgeEl.className = "badge rounded-pill text-bg-success";
	});
	socketEl.addEventListener("message", (event: MessageEvent): void => {
		const message: GatewayMessage = JSON.parse(event.data as string) as GatewayMessage;
		if (message.type === "devices" && message.devices) {
			devicesEl.innerHTML = message.devices.filter((device: DeviceSummary) => device.deviceRole === "worker").map((device: DeviceSummary) => `<li>${device.name} (worker) — ${device.stageNames.join(", ")}</li>`).join("") || "<li>Waiting for worker browser tabs.</li>";
		}
		if ((message.type === "task.updated" || message.type === "task.accepted") && message.task){
			tasksEl.textContent = JSON.stringify(message.task, null, 2);
		}
	});
	socketEl.addEventListener("close", (): void => {
		statusEl.textContent = "Disconnected from the central gateway.";
		statusBadgeEl.textContent = "Disconnected";
		statusBadgeEl.className = "badge rounded-pill text-bg-danger";
	});
})();
