export { };
import type { Device, DeviceRole, Task } from "@webai/protocol";
import { splitDevices, stageStatistics } from "../../../src/dashboard.js";

type DeviceSummary = {
	deviceId: string;
	deviceRole: DeviceRole;
	name: string;
	stageNames: string[];
	connectedAt: string;
	lastSeenAt: string;
};

type GatewayMessage = {
	type: string;
	devices?: Device[];
	device?: Device;
	deviceId?: string;
	task?: Task;
	code?: string;
	message?: string;
};

type DashboardEvent = {
	type: string;
	timestamp: string;
	details: string;
};

const maximumDisplayedEvents = 10;

/** The gateway message types that carry a device list or a single device change. */
const deviceMessageTypes = ["devices", "device.joined", "device.updated", "device.left"];

/**
 * The bearer token this dashboard page presents to the central gateway. It matches the
 * gateway's own `--auth-token` default, the same way the worker browser page does.
 */
const gatewayAuthenticationToken = "development-token";

const escapeHtml = (value: string): string => value
	.replaceAll("&", "&amp;")
	.replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;")
	.replaceAll('"', "&quot;")
	.replaceAll("'", "&#039;");

const formatTime = (timestamp: string): string => new Date(timestamp).toLocaleTimeString();

/**
 * Counts the currently known devices for the recent gateway events list.
 *
 * @param deviceById - Every device the page currently knows about, keyed by device identifier.
 * @returns A sentence such as "2 workers, 1 consumer".
 */
const describeDeviceCount = (deviceById: Map<string, Device>): string => {
	const devices = splitDevices([...deviceById.values()]);
	const workerCount = devices.worker.length;
	const consumerCount = devices.consumer.length;
	return `${workerCount} worker${workerCount === 1 ? "" : "s"}, ${consumerCount} consumer${consumerCount === 1 ? "" : "s"}`;
};

/**
 * Describes a gateway message for the recent gateway events list. An error message shows
 * its own code and text, so the reason is readable on the page instead of being hidden
 * behind a generic line.
 *
 * @param message - The gateway message that was received.
 * @returns The text to show underneath the message type.
 */
const describeMessage = (message: GatewayMessage): string => {
	if (message.type !== "error") return "Gateway message received";
	return `${message.code ?? "UNKNOWN"}: ${message.message ?? "No description was provided"}`;
};

const taskSummary = (task: Task): string => {
	const input = task.input.input;
	return `${task.input.taskType === "task_type_formula" ? "Formula" : "Language model"} · ${task.state} · input: ${String(input).slice(0, 80)}`;
};

const getElement = (selector: string): HTMLElement => {
	const element: Element | null = document.querySelector(selector);
	if (!(element instanceof HTMLElement)) throw new Error(`Element ${selector} was not found`);
	return element;
};

const configureFoldablePanels = (): void => {
	document.querySelectorAll<HTMLDetailsElement>("details[data-foldable-key]").forEach((panel) => {
		const storageKey = `webai-gateway-panel:${panel.dataset.foldableKey ?? "unknown"}`;
		try {
			panel.open = window.localStorage.getItem(storageKey) === "open";
		} catch {
			panel.open = false;
		}
		panel.addEventListener("toggle", (): void => {
			try {
				window.localStorage.setItem(storageKey, panel.open ? "open" : "closed");
			} catch {
				// Local storage can be unavailable in privacy-restricted browsers.
			}
		});
	});
};

((): void => {
	configureFoldablePanels();
	const statusEl: HTMLElement = getElement("#status");
	const statusBadgeEl: HTMLElement = getElement("#status-badge");
	const workersEl: HTMLElement = getElement("#workers");
	const consumersEl: HTMLElement = getElement("#consumers");
	const tasksEl: HTMLElement = getElement("#tasks");
	const workerCountEl: HTMLElement = getElement("#worker-count");
	const consumerCountEl: HTMLElement = getElement("#consumer-count");
	const stageCountEl: HTMLElement = getElement("#stage-count");
	const stagesEl: HTMLElement = getElement("#stages");
	const eventsEl: HTMLElement = getElement("#events");
	const events: DashboardEvent[] = [];
	const addEvent = (event: DashboardEvent): void => {
		events.push(event);
		if (events.length > maximumDisplayedEvents) events.splice(0, events.length - maximumDisplayedEvents);
		eventsEl.innerHTML = events.slice().reverse().map((item) => `<article class="event-item"><div class="d-flex justify-content-between gap-3"><strong>${escapeHtml(item.type)}</strong><time class="text-secondary">${escapeHtml(formatTime(item.timestamp))}</time></div><div class="small text-secondary">${escapeHtml(item.details)}</div></article>`).join("");
	};
	// The central gateway sends the full device list once, as the reply to "observe", and
	// afterwards only sends what changed, as "device.joined", "device.updated" and
	// "device.left". Keeping the devices here lets every one of those messages redraw the
	// panels, instead of the counts standing still until the page is reloaded.
	const deviceById = new Map<string, Device>();
	const renderDevices = (): void => {
		const devices = splitDevices([...deviceById.values()]);
		const workers = devices.worker;
		const consumers = devices.consumer;
		workerCountEl.textContent = String(workers.length);
		consumerCountEl.textContent = String(consumers.length);
		workersEl.innerHTML = workers.map((device: DeviceSummary) => connectionMarkup(device, true)).join("") || '<p class="text-secondary mb-0">No worker browsers are connected.</p>';
		consumersEl.innerHTML = consumers.map((device: DeviceSummary) => connectionMarkup(device, false)).join("") || '<p class="text-secondary mb-0">No consumers are connected.</p>';
		const statistics = stageStatistics(workers);
		stageCountEl.textContent = String(statistics.total);
		stagesEl.innerHTML = statistics.stages.map((stage) => `<div class="stage-stat"><div class="d-flex justify-content-between"><span>${escapeHtml(stage.stageName)}</span><span class="text-secondary">${stage.count} worker${stage.count === 1 ? "" : "s"} · ${stage.percentage.toFixed(1)}%</span></div><div class="progress" role="progressbar" aria-label="${escapeHtml(stage.stageName)} percentage" aria-valuenow="${stage.percentage}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width: ${stage.percentage}%"></div></div></div>`).join("") || '<p class="text-secondary mb-0">No worker stages are enabled.</p>';
	};
	const socketEl: WebSocket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);

	socketEl.addEventListener("open", (): void => {
		socketEl.send(JSON.stringify({ type: "authenticate", token: gatewayAuthenticationToken }));
		statusEl.textContent = "Connected to the central gateway.";
		statusBadgeEl.textContent = "Connected";
		statusBadgeEl.className = "badge rounded-pill text-bg-success";
	});
	socketEl.addEventListener("message", (event: MessageEvent): void => {
		const message: GatewayMessage = JSON.parse(event.data as string) as GatewayMessage;
		if (message.type === "authenticated") {
			socketEl.send(JSON.stringify({ type: "observe" }));
			addEvent({ type: "Authenticated", timestamp: new Date().toISOString(), details: "Now observing the central gateway" });
			return;
		}
		if (message.type === "devices" && message.devices) {
			deviceById.clear();
			for (const device of message.devices) deviceById.set(device.deviceId, device);
			renderDevices();
			addEvent({ type: "Device list received", timestamp: new Date().toISOString(), details: describeDeviceCount(deviceById) });
		}
		if ((message.type === "device.joined" || message.type === "device.updated") && message.device) {
			deviceById.set(message.device.deviceId, message.device);
			renderDevices();
			addEvent({ type: message.type === "device.joined" ? "Device joined" : "Device updated", timestamp: new Date().toISOString(), details: `${message.device.name} · ${describeDeviceCount(deviceById)}` });
		}
		if (message.type === "device.left" && message.deviceId !== undefined) {
			const departed = deviceById.get(message.deviceId);
			deviceById.delete(message.deviceId);
			renderDevices();
			addEvent({ type: "Device left", timestamp: new Date().toISOString(), details: `${departed?.name ?? message.deviceId} · ${describeDeviceCount(deviceById)}` });
		}
		if ((message.type === "task.updated" || message.type === "task.accepted") && message.task){
			tasksEl.innerHTML = `<div class="d-flex justify-content-between gap-3 mb-2"><strong>${escapeHtml(message.task.taskId)}</strong><span class="badge text-bg-light border">${escapeHtml(message.task.state)}</span></div><p class="mb-2">${escapeHtml(taskSummary(message.task))}</p><div class="small text-secondary">Completed stages: ${message.task.completedStages.length}</div>${message.task.error ? `<div class="alert alert-danger mt-3 mb-0 py-2">${escapeHtml(message.task.error)}</div>` : ""}`;
			addEvent({ type: message.type === "task.accepted" ? "Task accepted" : "Task updated", timestamp: new Date().toISOString(), details: taskSummary(message.task) });
		}
		if (deviceMessageTypes.includes(message.type) === false && message.type !== "task.updated" && message.type !== "task.accepted") addEvent({ type: message.type, timestamp: new Date().toISOString(), details: describeMessage(message) });
	});
	socketEl.addEventListener("close", (): void => {
		statusEl.textContent = "Disconnected from the central gateway.";
		statusBadgeEl.textContent = "Disconnected";
		statusBadgeEl.className = "badge rounded-pill text-bg-danger";
	});
})();

function connectionMarkup(device: DeviceSummary, includeStages: boolean): string {
	const stages = includeStages ? `<dt class="col-4 text-secondary">Stages</dt><dd class="col-8"><div class="d-flex flex-wrap gap-1">${device.stageNames.map((stageName) => `<span class="badge text-bg-light border">${escapeHtml(stageName)}</span>`).join("")}</div></dd>` : "";
	return `<article class="worker-item"><div class="d-flex justify-content-between gap-3"><h3 class="h6 mb-1">${escapeHtml(device.name)}</h3><span class="badge text-bg-success">Connected</span></div><dl class="row small mb-0"><dt class="col-4 text-secondary">Device ID</dt><dd class="col-8 text-break">${escapeHtml(device.deviceId)}</dd>${stages}<dt class="col-4 text-secondary">Connected</dt><dd class="col-8">${escapeHtml(formatTime(device.connectedAt))}</dd><dt class="col-4 text-secondary">Last seen</dt><dd class="col-8">${escapeHtml(formatTime(device.lastSeenAt))}</dd></dl></article>`;
}
