export { };
import type { Device, DeviceActivity, DeviceRole, TaskSnapshot, TaskUpdate } from "@webai/protocol";
import { Envelope } from "@webai/protocol/envelope";
import { SessionRenewal } from "@webai/protocol/session_renewal";
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
	/** The full device list on a `devices` message, and the changed activity fields on a `device.activity` message. */
	devices?: Device[] | DeviceActivity[];
	device?: Device;
	deviceId?: string;
	task?: TaskSnapshot;
	update?: TaskUpdate;
	code?: string;
	message?: string;
	/** When the authenticated session expires, in reply to `authenticate`. */
	expiresAt?: string;
};

type DashboardEvent = {
	type: string;
	timestamp: string;
	details: string;
};

const maximumDisplayedEvents = 10;

/** The gateway message types that carry a device list or a single device change. */
const deviceMessageTypes = ["devices", "device.joined", "device.updated", "device.activity", "device.left"];
/** Message types the task panel already reports on its own, so the event list does not repeat them. */
const taskPanelMessageTypes = ["task.accepted", "task.snapshot", "task.updated"];

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

/**
 * What this page knows about the most recent task.
 *
 * The central gateway sends the full task state only when a client asks for a task, as
 * `task.accepted` or `task.snapshot`. Every revision afterwards arrives as the slim
 * `task.updated` projection, which carries no task input and no stage values. Keeping
 * the last full state here lets each revision redraw the panel with the input still
 * shown, instead of the panel emptying out as soon as the task advances.
 */
type TaskPanelState = {
	snapshot?: TaskSnapshot;
	update?: TaskUpdate;
};

const taskSummary = (panel: TaskPanelState): string => {
	const state = panel.update?.state ?? panel.snapshot?.state ?? "unknown";
	const taskInput = panel.snapshot?.input;
	if (taskInput === undefined) return `Task · ${state} · input: not known to this connection`;
	return `${taskInput.taskType === "task_type_formula" ? "Formula" : "Language model"} · ${state} · input: ${String(taskInput.input).slice(0, 80)}`;
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
	const taskPanel: TaskPanelState = {};
	const renderTask = (): void => {
		const taskId = taskPanel.update?.taskId ?? taskPanel.snapshot?.taskId ?? "";
		const state = taskPanel.update?.state ?? taskPanel.snapshot?.state ?? "unknown";
		const completedStageCount = taskPanel.update?.completedStageCount ?? taskPanel.snapshot?.completedStages.length ?? 0;
		const error = taskPanel.update?.error ?? taskPanel.snapshot?.error;
		tasksEl.innerHTML = `<div class="d-flex justify-content-between gap-3 mb-2"><strong>${escapeHtml(taskId)}</strong><span class="badge text-bg-light border">${escapeHtml(state)}</span></div><p class="mb-2">${escapeHtml(taskSummary(taskPanel))}</p><div class="small text-secondary">Completed stages: ${completedStageCount}</div>${error ? `<div class="alert alert-danger mt-3 mb-0 py-2">${escapeHtml(error)}</div>` : ""}`;
	};
	// This page is an observer connection, which the central gateway treats as a device
	// membership subscription. The gateway sends the full device list once, as the reply
	// to "observe", and afterwards only sends what changed: "device.joined" and
	// "device.left" for devices arriving and leaving, "device.updated" when a device's own
	// description changes, and "device.activity" for how busy a device is. Keeping the
	// devices here lets every one of those messages redraw the panels, instead of the
	// counts standing still until the page is reloaded.
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
	/** Whether this dashboard has already asked to observe on the current connection. */
	let isObserving = false;
	/** The pending timer that authenticates again before the current session expires. */
	let sessionRenewalTimer: number | undefined;

	/**
	 * Authenticates again before the current session runs out, so this dashboard keeps
	 * working for as long as the page is open.
	 *
	 * @param expiresAt When the current session expires, as the gateway stated it.
	 */
	const scheduleSessionRenewal = (expiresAt: string | undefined): void => {
		if (sessionRenewalTimer !== undefined) window.clearTimeout(sessionRenewalTimer);
		if (expiresAt === undefined) return;
		sessionRenewalTimer = window.setTimeout((): void => {
			if (socketEl.readyState !== WebSocket.OPEN) return;
			socketEl.send(JSON.stringify(Envelope.fromClient({ type: "authenticate", token: gatewayAuthenticationToken })));
		}, SessionRenewal.renewAfterMs(expiresAt));
	};

	socketEl.addEventListener("open", (): void => {
		const authenticateMessage = { type: "authenticate" as const, token: gatewayAuthenticationToken };
		socketEl.send(JSON.stringify(Envelope.fromClient(authenticateMessage)));
		statusEl.textContent = "Authenticating with the central gateway.";
		statusBadgeEl.textContent = "Authenticating";
		statusBadgeEl.className = "badge rounded-pill text-bg-warning";
	});
	socketEl.addEventListener("message", (event: MessageEvent): void => {
		const frame = JSON.parse(event.data as string) as { body?: GatewayMessage };
		const message = frame.body;
		if (message === undefined) return;
		if (message.type === "authenticated") {
			statusEl.textContent = "Connected to the central gateway.";
			statusBadgeEl.textContent = "Connected";
			statusBadgeEl.className = "badge rounded-pill text-bg-success";
			// This dashboard stays open indefinitely and the gateway enforces the expiry it
			// just advertised, so the session is renewed before that moment. A renewal is
			// answered with "authenticated" too, and must not start observing a second time.
			scheduleSessionRenewal(message.expiresAt);
			if (isObserving === false) {
				isObserving = true;
				socketEl.send(JSON.stringify(Envelope.fromClient({ type: "observe" })));
				addEvent({ type: "Authenticated", timestamp: new Date().toISOString(), details: "Now observing the central gateway" });
			}
			return;
		}
		if (message.type === "devices" && message.devices) {
			deviceById.clear();
			for (const device of message.devices as Device[]) deviceById.set(device.deviceId, device);
			renderDevices();
			addEvent({ type: "Device list received", timestamp: new Date().toISOString(), details: describeDeviceCount(deviceById) });
		}
		if ((message.type === "device.joined" || message.type === "device.updated") && message.device) {
			deviceById.set(message.device.deviceId, message.device);
			renderDevices();
			addEvent({ type: message.type === "device.joined" ? "Device joined" : "Device updated", timestamp: new Date().toISOString(), details: `${message.device.name} · ${describeDeviceCount(deviceById)}` });
		}
		// The central gateway sends how busy each device is on its own, batched over a
		// short window, rather than re-sending whole device records every time a worker
		// picks up or finishes a stage. Merging the activity fields into the stored device
		// keeps the counts and the busy or idle state current without losing the device's
		// name and stage list, which activity messages do not carry.
		if (message.type === "device.activity" && message.devices) {
			for (const activity of message.devices as DeviceActivity[]) {
				const stored = deviceById.get(activity.deviceId);
				if (stored === undefined) continue;
				deviceById.set(activity.deviceId, { ...stored, ...activity });
			}
			renderDevices();
			addEvent({ type: "Device activity", timestamp: new Date().toISOString(), details: `${message.devices.length} device${message.devices.length === 1 ? "" : "s"} · ${describeDeviceCount(deviceById)}` });
		}
		if (message.type === "device.left" && message.deviceId !== undefined) {
			const departed = deviceById.get(message.deviceId);
			deviceById.delete(message.deviceId);
			renderDevices();
			addEvent({ type: "Device left", timestamp: new Date().toISOString(), details: `${departed?.name ?? message.deviceId} · ${describeDeviceCount(deviceById)}` });
		}
		if ((message.type === "task.accepted" || message.type === "task.snapshot") && message.task) {
			taskPanel.snapshot = message.task;
			if (taskPanel.update?.taskId !== message.task.taskId) taskPanel.update = undefined;
			renderTask();
			addEvent({ type: message.type === "task.accepted" ? "Task accepted" : "Task state received", timestamp: new Date().toISOString(), details: taskSummary(taskPanel) });
		}
		if (message.type === "task.updated" && message.update) {
			if (taskPanel.snapshot?.taskId !== message.update.taskId) taskPanel.snapshot = undefined;
			taskPanel.update = message.update;
			renderTask();
			addEvent({ type: "Task updated", timestamp: new Date().toISOString(), details: taskSummary(taskPanel) });
		}
		if (deviceMessageTypes.includes(message.type) === false && taskPanelMessageTypes.includes(message.type) === false) addEvent({ type: message.type, timestamp: new Date().toISOString(), details: describeMessage(message) });
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
