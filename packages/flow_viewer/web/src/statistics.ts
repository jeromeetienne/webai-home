import type { LogEntry } from '@webai/protocol/message_logger';
import type { LogSource, TimeRangeMs, TimelineEvent } from './types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Statistics — measures the traffic of a capture the viewer is showing
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One set of measured totals, for the whole capture or for one group within it. */
export type StatisticsTotals = {
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
};

/** The measured totals for the whole capture, and for each way of grouping it. */
export type StatisticsReport = {
	total: StatisticsTotals;
	byTask: Map<string, StatisticsTotals>;
	byRoute: Map<string, StatisticsTotals>;
	byWorker: Map<string, StatisticsTotals>;
	byStage: Map<string, StatisticsTotals>;
	byMessageType: Map<string, StatisticsTotals>;
};

/**
 * Measures how much traffic a capture carried, and how much of it was repeated.
 *
 * The same events the viewer draws are measured here, so the figures on screen always
 * describe exactly what is being shown, including the time range currently selected.
 */
export class Statistics {
	/**
	 * Calculates capture statistics from the same events rendered by the viewer.
	 *
	 * @param sources The captures the events were read from.
	 * @param events Every event the viewer holds, in time order.
	 * @param range The time range currently selected. Events outside it are not counted.
	 * @returns The totals for the whole capture and for each way of grouping it.
	 */
	static calculateStatistics(sources: LogSource[], events: TimelineEvent[], range: TimeRangeMs): StatisticsReport {
		const report: StatisticsReport = { total: Statistics.emptyTotals(), byTask: new Map(), byRoute: new Map(), byWorker: new Map(), byStage: new Map(), byMessageType: new Map() };
		const seenPayloads = new Map<string, number>();
		const pending = new Map<string, number>();
		const addTo = (map: Map<string, StatisticsTotals>, key: string, event: TimelineEvent, duplicateBytes: number): void => {
			const totals = map.get(key) ?? Statistics.emptyTotals();
			Statistics.add(totals, event.logEntry, duplicateBytes);
			map.set(key, totals);
		};

		for (const event of events) {
			if (event.timestampMs < range.fromMs || event.timestampMs > range.toMs) continue;
			const payloadKey = JSON.stringify(event.logEntry.payload);
			const payloadBytes = event.logEntry.payloadBytes ?? new TextEncoder().encode(payloadKey).byteLength;
			const duplicateBytes = seenPayloads.has(payloadKey) ? payloadBytes : 0;
			seenPayloads.set(payloadKey, (seenPayloads.get(payloadKey) ?? 0) + 1);
			const route = `${event.fromActorId} → ${event.toActorId}`;
			const worker = event.toActorId.startsWith('worker:') ? event.toActorId : event.fromActorId.startsWith('worker:') ? event.fromActorId : '—';
			const stage = (event.logEntry.payload as { stage?: unknown }).stage;
			Statistics.add(report.total, event.logEntry, duplicateBytes);
			addTo(report.byRoute, route, event, duplicateBytes);
			addTo(report.byMessageType, event.messageType, event, duplicateBytes);
			if (event.taskId !== undefined) addTo(report.byTask, event.taskId, event, duplicateBytes);
			if (worker !== '—') addTo(report.byWorker, worker, event, duplicateBytes);
			if (typeof stage === 'string') addTo(report.byStage, stage, event, duplicateBytes);

			const task = event.taskId ?? '';
			const stageName = typeof stage === 'string' ? stage : '';
			if (task !== '' && ((event.messageType === 'task.submit' && event.direction === 'received') || (event.messageType === 'stage.assign' && event.direction === 'sent'))) pending.set(`${event.messageType}:${task}:${stageName}`, event.timestampMs);
			const matching = event.messageType === 'task.accepted' ? `task.submit:${task}:` : event.messageType === 'stage.result' ? `stage.assign:${task}:${stageName}` : undefined;
			const start = matching === undefined ? undefined : pending.get(matching);
			if (matching !== undefined && start !== undefined) {
				pending.delete(matching);
				const latency = event.timestampMs - start;
				if (latency >= 0) {
					Statistics.addLatency(report.total, latency);
					if (event.taskId !== undefined) {
						const taskTotals = report.byTask.get(event.taskId) ?? Statistics.emptyTotals();
						Statistics.addLatency(taskTotals, latency);
						report.byTask.set(event.taskId, taskTotals);
					}
				}
			}
		}
		return report;
	}

	/**
	 * Writes a byte count the way it is shown on screen.
	 *
	 * @param bytes The number of bytes.
	 * @returns The count in bytes, kibibytes, or mebibytes, whichever reads shortest.
	 */
	static formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
	}

	/**
	 * Writes the average latency of one set of totals the way it is shown on screen.
	 *
	 * @param totals The totals to average.
	 * @returns The average in milliseconds, or a dash when nothing was measured.
	 */
	static formatLatency(totals: StatisticsTotals): string {
		if (totals.latencySamples === 0 || totals.latencyMs === undefined) return '—';
		return `${(totals.latencyMs / totals.latencySamples).toFixed(1)} ms avg`;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Accumulating
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/** Returns a set of totals with nothing counted yet. */
	private static emptyTotals(): StatisticsTotals {
		return {
			messageCount: 0, payloadBytes: 0, messageBytes: 0, duplicateBytes: 0,
			usefulBytes: 0, protocolOverheadBytes: 0, measuredMessages: 0,
			estimatedMessages: 0, latencyMs: undefined, latencySamples: 0,
		};
	}

	/**
	 * Adds one latency sample to a set of totals.
	 *
	 * @param totals The totals to add to, changed in place.
	 * @param latencyMs The measured latency in milliseconds.
	 */
	private static addLatency(totals: StatisticsTotals, latencyMs: number): void {
		totals.latencyMs = (totals.latencyMs ?? 0) + latencyMs;
		totals.latencySamples += 1;
	}

	/**
	 * Adds one message to a set of totals.
	 *
	 * A log entry that states no byte counts is measured by encoding its payload again, and
	 * is counted as estimated rather than measured.
	 *
	 * @param totals The totals to add to, changed in place.
	 * @param entry The log entry for the message.
	 * @param duplicateBytes How many of the message's bytes repeated a payload already seen.
	 */
	private static add(totals: StatisticsTotals, entry: LogEntry, duplicateBytes: number): void {
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
	}
}
