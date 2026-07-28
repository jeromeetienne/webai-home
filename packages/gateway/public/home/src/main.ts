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
	task?: Task;
};

type DashboardEvent = {
	type: string;
	timestamp: string;
	details: string;
};

const maximumDisplayedEvents = 10;

const escapeHtml = (value: string): string => value
	.replaceAll("&", "&amp;")
	.replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;")
	.replaceAll('"', "&quot;")
	.replaceAll("'", "&#039;");

const formatTime = (timestamp: string): string => new Date(timestamp).toLocaleTimeString();

const taskSummary = (task: Task): string => {
	const input = task.input.input;
	return `${task.input.taskType === "task_type_formula" ? "Formula" : "Language model"} · ${task.state} · input: ${String(input).slice(0, 80)}`;
};

const getElement = (selector: string): HTMLElement => {
	const element: Element | null = document.querySelector(selector);
	if (!(element instanceof HTMLElement)) throw new Error(`Element ${selector} was not found`);
	return element;
};

((): void => {
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
			const devices = splitDevices(message.devices);
			const workers = devices.worker;
			const consumers = devices.consumer;
			workerCountEl.textContent = String(workers.length);
			consumerCountEl.textContent = String(consumers.length);
			workersEl.innerHTML = workers.map((device: DeviceSummary) => connectionMarkup(device, true)).join("") || '<p class="text-secondary mb-0">No worker browsers are connected.</p>';
			consumersEl.innerHTML = consumers.map((device: DeviceSummary) => connectionMarkup(device, false)).join("") || '<p class="text-secondary mb-0">No consumers are connected.</p>';
			const statistics = stageStatistics(workers);
			stageCountEl.textContent = String(statistics.total);
			stagesEl.innerHTML = statistics.stages.map((stage) => `<div class="stage-stat"><div class="d-flex justify-content-between"><span>${escapeHtml(stage.stageName)}</span><span class="text-secondary">${stage.count} worker${stage.count === 1 ? "" : "s"} · ${stage.percentage.toFixed(1)}%</span></div><div class="progress" role="progressbar" aria-label="${escapeHtml(stage.stageName)} percentage" aria-valuenow="${stage.percentage}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width: ${stage.percentage}%"></div></div></div>`).join("") || '<p class="text-secondary mb-0">No worker stages are enabled.</p>';
			addEvent({ type: "Worker list updated", timestamp: new Date().toISOString(), details: `${workers.length} connected worker${workers.length === 1 ? "" : "s"}` });
		}
		if ((message.type === "task.updated" || message.type === "task.accepted") && message.task){
			tasksEl.innerHTML = `<div class="d-flex justify-content-between gap-3 mb-2"><strong>${escapeHtml(message.task.taskId)}</strong><span class="badge text-bg-light border">${escapeHtml(message.task.state)}</span></div><p class="mb-2">${escapeHtml(taskSummary(message.task))}</p><div class="small text-secondary">Completed stages: ${message.task.completedStages.length}</div>${message.task.error ? `<div class="alert alert-danger mt-3 mb-0 py-2">${escapeHtml(message.task.error)}</div>` : ""}`;
			addEvent({ type: message.type === "task.accepted" ? "Task accepted" : "Task updated", timestamp: new Date().toISOString(), details: taskSummary(message.task) });
		}
		if (message.type !== "devices" && message.type !== "task.updated" && message.type !== "task.accepted") addEvent({ type: message.type, timestamp: new Date().toISOString(), details: "Gateway message received" });
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
