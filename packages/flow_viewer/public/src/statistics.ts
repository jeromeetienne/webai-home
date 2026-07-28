import type { LogEntry } from "@webai/protocol/message_logger";
import type { LogSource, TimeRangeMs, TimelineEvent } from "./types.js";

export interface StatisticsTotals {
	messageCount: number;
	payloadBytes: number;
	messageBytes: number;
	duplicateBytes: number;
	usefulBytes: number;
	protocolOverheadBytes: number;
	measuredMessages: number;
	estimatedMessages: number;
	latencyMs: number | undefined;
	latencySamples: number;
}

export interface StatisticsReport {
	total: StatisticsTotals;
	byTask: Map<string, StatisticsTotals>;
	byRoute: Map<string, StatisticsTotals>;
	byWorker: Map<string, StatisticsTotals>;
	byStage: Map<string, StatisticsTotals>;
	byMessageType: Map<string, StatisticsTotals>;
}

const emptyTotals = (): StatisticsTotals => ({
	messageCount: 0, payloadBytes: 0, messageBytes: 0, duplicateBytes: 0,
	usefulBytes: 0, protocolOverheadBytes: 0, measuredMessages: 0,
	estimatedMessages: 0, latencyMs: undefined, latencySamples: 0,
});

const addLatency = (totals: StatisticsTotals, latencyMs: number): void => {
	totals.latencyMs = (totals.latencyMs ?? 0) + latencyMs;
	totals.latencySamples += 1;
};

const add = (totals: StatisticsTotals, entry: LogEntry, duplicateBytes: number): void => {
	const payloadBytes = entry.payloadBytes ?? new TextEncoder().encode(JSON.stringify(entry.payload)).byteLength;
	const messageBytes = entry.messageBytes ?? new TextEncoder().encode(JSON.stringify(entry.payload)).byteLength;
	totals.messageCount += 1;
	totals.payloadBytes += payloadBytes;
	totals.messageBytes += messageBytes;
	totals.duplicateBytes += duplicateBytes;
	totals.usefulBytes += payloadBytes;
	totals.protocolOverheadBytes += Math.max(0, messageBytes - payloadBytes);
	if (entry.payloadBytes !== undefined && entry.messageBytes !== undefined) totals.measuredMessages += 1;
	else totals.estimatedMessages += 1;
};

/** Calculates capture statistics from the same events rendered by the viewer. */
export function calculateStatistics(sources: LogSource[], events: TimelineEvent[], range: TimeRangeMs): StatisticsReport {
	const report: StatisticsReport = { total: emptyTotals(), byTask: new Map(), byRoute: new Map(), byWorker: new Map(), byStage: new Map(), byMessageType: new Map() };
	const seenPayloads = new Map<string, number>();
	const pending = new Map<string, number>();
	const addTo = (map: Map<string, StatisticsTotals>, key: string, event: TimelineEvent, duplicateBytes: number): void => {
		const totals = map.get(key) ?? emptyTotals();
		add(totals, event.logEntry, duplicateBytes);
		map.set(key, totals);
	};

	for (const event of events) {
		if (event.timestampMs < range.fromMs || event.timestampMs > range.toMs) continue;
		const payloadKey = JSON.stringify(event.logEntry.payload);
		const payloadBytes = event.logEntry.payloadBytes ?? new TextEncoder().encode(payloadKey).byteLength;
		const duplicateBytes = seenPayloads.has(payloadKey) ? payloadBytes : 0;
		seenPayloads.set(payloadKey, (seenPayloads.get(payloadKey) ?? 0) + 1);
		const route = `${event.fromActorId} → ${event.toActorId}`;
		const worker = event.toActorId.startsWith("worker:") ? event.toActorId : event.fromActorId.startsWith("worker:") ? event.fromActorId : "—";
		const stage = (event.logEntry.payload as { stage?: unknown }).stage;
		add(report.total, event.logEntry, duplicateBytes);
		addTo(report.byRoute, route, event, duplicateBytes);
		addTo(report.byMessageType, event.messageType, event, duplicateBytes);
		if (event.taskId !== undefined) addTo(report.byTask, event.taskId, event, duplicateBytes);
		if (worker !== "—") addTo(report.byWorker, worker, event, duplicateBytes);
		if (typeof stage === "string") addTo(report.byStage, stage, event, duplicateBytes);

		const task = event.taskId ?? "";
		const stageName = typeof stage === "string" ? stage : "";
		if (task !== "" && ((event.messageType === "task.submit" && event.direction === "received") || (event.messageType === "stage.assign" && event.direction === "sent"))) pending.set(`${event.messageType}:${task}:${stageName}`, event.timestampMs);
		const matching = event.messageType === "task.accepted" ? `task.submit:${task}:` : event.messageType === "stage.result" ? `stage.assign:${task}:${stageName}` : undefined;
		if (matching !== undefined && pending.has(matching)) {
			const start = pending.get(matching)!;
			pending.delete(matching);
			const latency = event.timestampMs - start;
			if (latency >= 0) {
				addLatency(report.total, latency);
				if (event.taskId !== undefined) {
					const taskTotals = report.byTask.get(event.taskId) ?? emptyTotals();
					addLatency(taskTotals, latency);
					report.byTask.set(event.taskId, taskTotals);
				}
			}
		}
	}
	return report;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatLatency(totals: StatisticsTotals): string {
	return totals.latencySamples === 0 ? "—" : `${(totals.latencyMs! / totals.latencySamples).toFixed(1)} ms avg`;
}
