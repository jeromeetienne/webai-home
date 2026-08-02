import type { LogEntry } from '@webai/protocol/message_logger';
import type { LogFileContents } from './log_entry_reader.js';
import { LogTaskTimeline, type StageRunRecord, type TaskRecord, type TaskTimeline } from './log_task_timeline.js';
import type {
	ConcernSection,
	CounterpartRow,
	Distribution,
	ExchangeRow,
	FileSection,
	LogStatisticsReport,
	MessageTypeRow,
	ReplySection,
	StageGroupRow,
	StageRunSection,
	TaskGroupRow,
	TaskSection,
	TimeSpanSection,
	TrafficSection,
} from './log_statistics_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LogStatistics — measures one .log_entry.jsonl file into a report
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The words in a message type that mean the message reports something going wrong. */
const failureWords = ['error', 'failed', 'failure', 'rejected', 'cancel', 'timeout', 'expired'];

/** How many unreadable lines are quoted in the report before the rest are only counted. */
const maximumUnreadableLineSamples = 5;

/**
 * Measures one message log file: how much traffic it carried, who carried it, how long each
 * answer took, and what became of every task and every stage run in it.
 *
 * Nothing here needs a connection to the central gateway. The report is built only from what
 * the file itself records, so an old capture measures exactly the same way as a fresh one.
 */
export class LogStatistics {
	/**
	 * Measures a log file that has already been read and parsed.
	 *
	 * @param contents The parsed contents of one `.log_entry.jsonl` file.
	 * @returns Every measurement the report holds.
	 */
	static calculate(contents: LogFileContents): LogStatisticsReport {
		const entries: LogEntry[] = contents.entries;
		const timeline: TaskTimeline = LogTaskTimeline.build(entries);
		const traffic: TrafficSection = LogStatistics._trafficSection(entries);
		return {
			file: LogStatistics._fileSection(contents),
			timeSpan: LogStatistics._timeSpanSection(entries),
			traffic,
			byMessageType: LogStatistics._messageTypeRows(entries, traffic),
			byCounterpart: LogStatistics._counterpartRows(entries),
			reply: LogStatistics._replySection(entries),
			tasks: LogStatistics._taskSection(timeline.tasks),
			stageRuns: LogStatistics._stageRunSection(timeline.stageRuns),
			concerns: LogStatistics._concernSection(contents, entries),
		};
	}

	/**
	 * Summarises how a set of measured numbers is spread out.
	 *
	 * The percentiles use the nearest-rank method: each one is the smallest measured value that
	 * the given share of the measurements falls at or below. That returns a value that was
	 * really observed, rather than one interpolated between two neighbours.
	 *
	 * @param values Every measured value, in any order. The array is not modified.
	 * @returns The count, extremes, percentiles, mean, and total of the values.
	 */
	static distribution(values: number[]): Distribution {
		if (values.length === 0) {
			return {
				count: 0,
				minimum: 0,
				median: 0,
				percentile90: 0,
				percentile99: 0,
				maximum: 0,
				mean: 0,
				total: 0,
			};
		}
		const sorted: number[] = [...values].sort((left: number, right: number): number => left - right);
		const total: number = sorted.reduce((sum: number, value: number): number => sum + value, 0);
		return {
			count: sorted.length,
			minimum: sorted[0] ?? 0,
			median: LogStatistics._percentile(sorted, 0.5),
			percentile90: LogStatistics._percentile(sorted, 0.9),
			percentile99: LogStatistics._percentile(sorted, 0.99),
			maximum: sorted[sorted.length - 1] ?? 0,
			mean: total / sorted.length,
			total,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Sections
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Describes the file itself: its size, how much of it was readable, and which protocol
	 * versions the messages in it stated.
	 *
	 * @param contents The parsed contents of one log file.
	 * @returns The file section of the report.
	 */
	private static _fileSection(contents: LogFileContents): FileSection {
		const protocolVersions = new Set<number>();
		for (const entry of contents.entries) {
			if (entry.protocolVersion !== undefined) {
				protocolVersions.add(entry.protocolVersion);
			}
		}
		return {
			filePath: contents.filePath,
			fileBytes: contents.fileBytes,
			lineCount: contents.lineCount,
			entryCount: contents.entries.length,
			unreadableLineCount: contents.lineErrors.length,
			protocolVersions: [...protocolVersions].sort((left: number, right: number): number => left - right),
		};
	}

	/**
	 * Measures when the traffic happened: the span the file covers, the average and peak rate,
	 * and how long the quiet stretches between messages were.
	 *
	 * @param entries Every log entry, oldest first.
	 * @returns The time span section of the report.
	 */
	private static _timeSpanSection(entries: LogEntry[]): TimeSpanSection {
		const moments: number[] = LogStatistics._timestampsMs(entries);
		if (moments.length === 0) {
			return {
				firstTimestamp: undefined,
				lastTimestamp: undefined,
				durationMs: 0,
				messagesPerSecond: 0,
				busiestSecondMessageCount: 0,
				busiestSecondTimestamp: undefined,
				gapMs: LogStatistics.distribution([]),
				longestSilenceMs: 0,
				longestSilenceStartsAt: undefined,
			};
		}

		const firstMs: number = moments[0] ?? 0;
		const lastMs: number = moments[moments.length - 1] ?? 0;
		const durationMs: number = lastMs - firstMs;

		const gaps: number[] = [];
		let longestSilenceMs = 0;
		let longestSilenceStartsAtMs: number | undefined;
		for (let index = 1; index < moments.length; index += 1) {
			const gapMs: number = (moments[index] ?? 0) - (moments[index - 1] ?? 0);
			gaps.push(gapMs);
			if (gapMs > longestSilenceMs) {
				longestSilenceMs = gapMs;
				longestSilenceStartsAtMs = moments[index - 1];
			}
		}

		const busiest = LogStatistics._busiestSecond(moments);
		return {
			firstTimestamp: new Date(firstMs).toISOString(),
			lastTimestamp: new Date(lastMs).toISOString(),
			durationMs,
			messagesPerSecond: durationMs > 0 ? (moments.length / (durationMs / 1000)) : 0,
			busiestSecondMessageCount: busiest.count,
			busiestSecondTimestamp: busiest.startsAtMs === undefined ? undefined : new Date(busiest.startsAtMs).toISOString(),
			gapMs: LogStatistics.distribution(gaps),
			longestSilenceMs,
			longestSilenceStartsAt: longestSilenceStartsAtMs === undefined ? undefined : new Date(longestSilenceStartsAtMs).toISOString(),
		};
	}

	/**
	 * Measures how much was carried: message counts and byte totals each way, how a single
	 * message's size is spread out, how much of the wire the envelope took rather than the
	 * message body, and how much of what was sent had already been sent once.
	 *
	 * @param entries Every log entry, oldest first.
	 * @returns The traffic section of the report.
	 */
	private static _trafficSection(entries: LogEntry[]): TrafficSection {
		const messageBytesValues: number[] = [];
		const messagePayloadBytesValues: number[] = [];
		const seenBodies = new Set<string>();
		let sentCount = 0;
		let receivedCount = 0;
		let sentBytes = 0;
		let receivedBytes = 0;
		let repeatedBodyCount = 0;
		let repeatedBodyBytes = 0;
		let largestMessage: TrafficSection['largestMessage'] = undefined;

		for (const entry of entries) {
			const messageBytes: number = LogStatistics._wireBytes(entry);
			messageBytesValues.push(messageBytes);
			if (entry.messagePayloadBytes !== undefined) {
				messagePayloadBytesValues.push(entry.messagePayloadBytes);
			}

			if (entry.direction === 'sent') {
				sentCount += 1;
				sentBytes += messageBytes;
			} else {
				receivedCount += 1;
				receivedBytes += messageBytes;
			}

			const bodyKey: string = JSON.stringify(entry.messagePayload);
			if (seenBodies.has(bodyKey) === true) {
				repeatedBodyCount += 1;
				repeatedBodyBytes += entry.messagePayloadBytes ?? messageBytes;
			} else {
				seenBodies.add(bodyKey);
			}

			if (largestMessage === undefined || messageBytes > largestMessage.messageBytes) {
				largestMessage = {
					messageType: entry.messageType,
					messageBytes,
					timestamp: entry.timestamp,
				};
			}
		}

		const messageBytes: Distribution = LogStatistics.distribution(messageBytesValues);
		const messagePayloadBytes: Distribution = LogStatistics.distribution(messagePayloadBytesValues);
		// Only the entries that recorded both sizes can say what the envelope cost, so the
		// overhead is taken against those entries' own wire total rather than against every
		// message, which would understate it whenever a log predates the byte counts.
		const comparableWireBytes: number = entries
			.filter((entry: LogEntry): boolean => entry.messagePayloadBytes !== undefined && entry.messageBytes !== undefined)
			.reduce((sum: number, entry: LogEntry): number => sum + (entry.messageBytes ?? 0), 0);
		const envelopeOverheadBytes: number = Math.max(0, comparableWireBytes - messagePayloadBytes.total);
		return {
			messageCount: entries.length,
			sentCount,
			receivedCount,
			sentBytes,
			receivedBytes,
			messageBytes,
			messagePayloadBytes,
			envelopeOverheadBytes,
			envelopeOverheadPercent: comparableWireBytes > 0 ? ((envelopeOverheadBytes / comparableWireBytes) * 100) : 0,
			repeatedBodyCount,
			repeatedBodyBytes,
			largestMessage,
		};
	}

	/**
	 * Counts and sizes every message type, so the few types that dominate a capture are
	 * immediately visible.
	 *
	 * @param entries Every log entry, oldest first.
	 * @param traffic The already-measured traffic totals, used to work out each type's share.
	 * @returns One row per message type, most frequent first.
	 */
	private static _messageTypeRows(entries: LogEntry[], traffic: TrafficSection): MessageTypeRow[] {
		const rows = new Map<string, MessageTypeRow>();
		for (const entry of entries) {
			const row: MessageTypeRow = rows.get(entry.messageType) ?? {
				messageType: entry.messageType,
				count: 0,
				countPercent: 0,
				sentCount: 0,
				receivedCount: 0,
				messageBytes: 0,
				bytesPercent: 0,
				meanMessageBytes: 0,
			};
			row.count += 1;
			row.messageBytes += LogStatistics._wireBytes(entry);
			if (entry.direction === 'sent') {
				row.sentCount += 1;
			} else {
				row.receivedCount += 1;
			}
			rows.set(entry.messageType, row);
		}

		const totalBytes: number = traffic.messageBytes.total;
		for (const row of rows.values()) {
			row.countPercent = entries.length > 0 ? ((row.count / entries.length) * 100) : 0;
			row.bytesPercent = totalBytes > 0 ? ((row.messageBytes / totalBytes) * 100) : 0;
			row.meanMessageBytes = row.count > 0 ? (row.messageBytes / row.count) : 0;
		}
		return [...rows.values()].sort((left: MessageTypeRow, right: MessageTypeRow): number => right.count - left.count);
	}

	/**
	 * Counts and sizes the traffic exchanged with each counterpart, and records when each one
	 * was first and last heard from.
	 *
	 * @param entries Every log entry, oldest first.
	 * @returns One row per counterpart, most messages first.
	 */
	private static _counterpartRows(entries: LogEntry[]): CounterpartRow[] {
		const rows = new Map<string, CounterpartRow>();
		for (const entry of entries) {
			const deviceId: string = entry.counterpart.deviceId ?? 'unknown';
			const key = `${entry.counterpart.role} ${deviceId}`;
			const row: CounterpartRow = rows.get(key) ?? {
				role: entry.counterpart.role,
				deviceId,
				count: 0,
				messageBytes: 0,
				firstSeenAt: entry.timestamp,
				lastSeenAt: entry.timestamp,
			};
			row.count += 1;
			row.messageBytes += LogStatistics._wireBytes(entry);
			row.lastSeenAt = entry.timestamp;
			rows.set(key, row);
		}
		return [...rows.values()].sort((left: CounterpartRow, right: CounterpartRow): number => right.count - left.count);
	}

	/**
	 * Measures how long each answer took, by matching every message that names the request it
	 * answers back to that request.
	 *
	 * @param entries Every log entry, oldest first.
	 * @returns The request and reply section of the report.
	 */
	private static _replySection(entries: LogEntry[]): ReplySection {
		const requestsById = new Map<string, LogEntry>();
		for (const entry of entries) {
			if (entry.messageId !== undefined) {
				requestsById.set(entry.messageId, entry);
			}
		}

		const latencies: number[] = [];
		const byExchange = new Map<string, number[]>();
		let unmatchedReplyCount = 0;
		let slowestExchange: ReplySection['slowestExchange'] = undefined;

		for (const entry of entries) {
			if (entry.inReplyToMessageId === undefined) {
				continue;
			}
			const request: LogEntry | undefined = requestsById.get(entry.inReplyToMessageId);
			if (request === undefined) {
				unmatchedReplyCount += 1;
				continue;
			}
			const latencyMs: number = Date.parse(entry.timestamp) - Date.parse(request.timestamp);
			if (Number.isFinite(latencyMs) === false || latencyMs < 0) {
				continue;
			}
			const exchange = `${request.messageType} → ${entry.messageType}`;
			latencies.push(latencyMs);
			byExchange.set(exchange, [...(byExchange.get(exchange) ?? []), latencyMs]);
			if (slowestExchange === undefined || latencyMs > slowestExchange.latencyMs) {
				slowestExchange = {
					exchange,
					latencyMs,
					timestamp: entry.timestamp,
				};
			}
		}

		const rows: ExchangeRow[] = [...byExchange.entries()]
			.map(([exchange, values]: [string, number[]]): ExchangeRow => ({
				exchange,
				count: values.length,
				latencyMs: LogStatistics.distribution(values),
			}))
			.sort((left: ExchangeRow, right: ExchangeRow): number => right.latencyMs.median - left.latencyMs.median);

		return {
			matchedCount: latencies.length,
			unmatchedReplyCount,
			latencyMs: LogStatistics.distribution(latencies),
			slowestExchange,
			byExchange: rows,
		};
	}

	/**
	 * Measures what became of the tasks: how many finished and how, how long each part of their
	 * life took, and how they were spread across task types and workers.
	 *
	 * @param tasks One record per task the log file mentions.
	 * @returns The task section of the report.
	 */
	private static _taskSection(tasks: TaskRecord[]): TaskSection {
		const admissions: number[] = [];
		const queueWaits: number[] = [];
		const endToEnds: number[] = [];
		const byFinalState = new Map<string, number>();
		const byTaskType = new Map<string, number>();
		const byWorker = new Map<string, number>();

		for (const task of tasks) {
			LogStatistics._addElapsed(admissions, task.submittedAtMs, task.acceptedAtMs);
			LogStatistics._addElapsed(queueWaits, task.acceptedAtMs ?? task.submittedAtMs, task.firstAssignedAtMs);
			LogStatistics._addElapsed(endToEnds, task.submittedAtMs ?? task.acceptedAtMs, task.finishedAtMs);
			LogStatistics._increment(byFinalState, task.finalState ?? 'never reported');
			LogStatistics._increment(byTaskType, task.taskType ?? 'not named in this log');
			for (const workerDeviceId of task.workerDeviceIds) {
				LogStatistics._increment(byWorker, workerDeviceId);
			}
		}

		const finishedIn = (state: string): number => tasks.filter((task: TaskRecord): boolean => task.finalState === state).length;
		return {
			taskCount: tasks.length,
			completedCount: finishedIn('completed'),
			failedCount: finishedIn('failed'),
			cancelledCount: finishedIn('cancelled'),
			unfinishedCount: tasks.filter((task: TaskRecord): boolean => task.finishedAtMs === undefined).length,
			retriedCount: tasks.filter((task: TaskRecord): boolean => task.maximumAttempt > 1).length,
			maximumAttempt: tasks.reduce((highest: number, task: TaskRecord): number => Math.max(highest, task.maximumAttempt), 0),
			admissionMs: LogStatistics.distribution(admissions),
			queueWaitMs: LogStatistics.distribution(queueWaits),
			endToEndMs: LogStatistics.distribution(endToEnds),
			stageRunsPerTask: LogStatistics.distribution(tasks.map((task: TaskRecord): number => task.stageRunCount)),
			messagesPerTask: LogStatistics.distribution(tasks.map((task: TaskRecord): number => task.messageCount)),
			bytesPerTask: LogStatistics.distribution(tasks.map((task: TaskRecord): number => task.messageBytes)),
			byFinalState: LogStatistics._groupRows(byFinalState),
			byTaskType: LogStatistics._groupRows(byTaskType),
			byWorker: LogStatistics._groupRows(byWorker),
		};
	}

	/**
	 * Measures each individual run of a stage on a worker: how quickly the worker picked the
	 * stage up, how long it took to answer, and how quickly the gateway recorded the answer.
	 *
	 * @param stageRuns One record per stage run the log file mentions.
	 * @returns The stage run section of the report.
	 */
	private static _stageRunSection(stageRuns: StageRunRecord[]): StageRunSection {
		const pickups: number[] = [];
		const computes: number[] = [];
		const commits: number[] = [];
		const computeByStageName = new Map<string, number[]>();
		const computeByWorker = new Map<string, number[]>();

		for (const stageRun of stageRuns) {
			LogStatistics._addElapsed(pickups, stageRun.assignedAtMs, stageRun.acceptedAtMs);
			LogStatistics._addElapsed(commits, stageRun.resultAtMs, stageRun.committedAtMs);

			const computeSamples: number[] = [];
			LogStatistics._addElapsed(computeSamples, stageRun.acceptedAtMs ?? stageRun.assignedAtMs, stageRun.resultAtMs);
			computes.push(...computeSamples);
			for (const computeMs of computeSamples) {
				LogStatistics._append(computeByStageName, stageRun.stageName ?? 'not named in this log', computeMs);
				LogStatistics._append(computeByWorker, stageRun.workerDeviceId ?? 'unknown', computeMs);
			}
		}

		return {
			stageRunCount: stageRuns.length,
			unfinishedCount: stageRuns.filter((stageRun: StageRunRecord): boolean => stageRun.resultAtMs === undefined).length,
			pickupMs: LogStatistics.distribution(pickups),
			computeMs: LogStatistics.distribution(computes),
			commitMs: LogStatistics.distribution(commits),
			byStageName: LogStatistics._stageGroupRows(computeByStageName),
			byWorker: LogStatistics._stageGroupRows(computeByWorker),
		};
	}

	/**
	 * Collects everything about the file that deserves a second look before its numbers are
	 * trusted, or that points at the cluster misbehaving.
	 *
	 * @param contents The parsed contents of one log file.
	 * @param entries Every log entry, oldest first.
	 * @returns The concerns section of the report.
	 */
	private static _concernSection(contents: LogFileContents, entries: LogEntry[]): ConcernSection {
		const errorMessageTypes = new Map<string, number>();
		let oversizeBodyCount = 0;
		let unidentifiedCounterpartCount = 0;

		for (const entry of entries) {
			if (LogStatistics._isFailureMessageType(entry.messageType) === true) {
				LogStatistics._increment(errorMessageTypes, entry.messageType);
			}
			const body = entry.messagePayload;
			if (typeof body === 'object' && body !== null && (body as { redacted?: unknown }).redacted === true) {
				oversizeBodyCount += 1;
			}
			if (entry.counterpart.deviceId === undefined) {
				unidentifiedCounterpartCount += 1;
			}
		}

		const errorMessageCount: number = [...errorMessageTypes.values()].reduce((sum: number, count: number): number => sum + count, 0);
		return {
			unreadableLineCount: contents.lineErrors.length,
			unreadableLineSamples: contents.lineErrors
				.slice(0, maximumUnreadableLineSamples)
				.map((lineError): string => `line ${lineError.lineNumber}: ${lineError.reason}`),
			outOfOrderCount: contents.outOfOrderCount,
			errorMessageCount,
			errorMessageTypes: LogStatistics._groupRows(errorMessageTypes),
			oversizeBodyCount,
			unidentifiedCounterpartCount,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads how many bytes a message took on the wire, falling back to the body size for a log
	 * recorded before the envelope size was written down.
	 *
	 * @param entry The log entry to size.
	 * @returns The message's size in bytes, or 0 when the entry records neither size.
	 */
	private static _wireBytes(entry: LogEntry): number {
		return entry.messageBytes ?? entry.messagePayloadBytes ?? 0;
	}

	/**
	 * Reads every entry's moment, dropping any timestamp that cannot be understood.
	 *
	 * @param entries Every log entry, oldest first.
	 * @returns The moments in milliseconds since the epoch, in the order the entries are in.
	 */
	private static _timestampsMs(entries: LogEntry[]): number[] {
		return entries
			.map((entry: LogEntry): number => Date.parse(entry.timestamp))
			.filter((timestampMs: number): boolean => Number.isNaN(timestampMs) === false);
	}

	/**
	 * Finds the busiest one-second window, by counting how many messages fall in the second
	 * that begins at each message in turn.
	 *
	 * @param moments Every message's moment in milliseconds since the epoch, oldest first.
	 * @returns How many messages the busiest second held, and when it began.
	 */
	private static _busiestSecond(moments: number[]): { count: number; startsAtMs: number | undefined } {
		let bestCount = 0;
		let bestStartsAtMs: number | undefined;
		let windowStart = 0;
		for (let index = 0; index < moments.length; index += 1) {
			while ((moments[index] ?? 0) - (moments[windowStart] ?? 0) >= 1000) {
				windowStart += 1;
			}
			const count: number = index - windowStart + 1;
			if (count > bestCount) {
				bestCount = count;
				bestStartsAtMs = moments[windowStart];
			}
		}
		return {
			count: bestCount,
			startsAtMs: bestStartsAtMs,
		};
	}

	/**
	 * Adds the time between two moments to a set of measurements, when both moments are known
	 * and the later one really is later.
	 *
	 * @param target The list of measurements to append to.
	 * @param fromMs The earlier moment, in milliseconds since the epoch.
	 * @param toMs The later moment, in milliseconds since the epoch.
	 */
	private static _addElapsed(target: number[], fromMs: number | undefined, toMs: number | undefined): void {
		if (fromMs === undefined || toMs === undefined) {
			return;
		}
		const elapsedMs: number = toMs - fromMs;
		if (elapsedMs < 0) {
			return;
		}
		target.push(elapsedMs);
	}

	/**
	 * Adds one to the count stored under a key.
	 *
	 * @param counts The counts to update.
	 * @param key The key to count against.
	 */
	private static _increment(counts: Map<string, number>, key: string): void {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	/**
	 * Appends one measurement to the list stored under a key.
	 *
	 * @param lists The lists to update.
	 * @param key The key to append against.
	 * @param value The measurement to append.
	 */
	private static _append(lists: Map<string, number[]>, key: string, value: number): void {
		lists.set(key, [...(lists.get(key) ?? []), value]);
	}

	/**
	 * Turns a set of counts into report rows, most frequent first.
	 *
	 * @param counts How many times each key was counted.
	 * @returns One row per key, most frequent first.
	 */
	private static _groupRows(counts: Map<string, number>): TaskGroupRow[] {
		return [...counts.entries()]
			.map(([key, count]: [string, number]): TaskGroupRow => ({
				key,
				count,
			}))
			.sort((left: TaskGroupRow, right: TaskGroupRow): number => right.count - left.count);
	}

	/**
	 * Turns sets of stage run compute times into report rows, slowest median first.
	 *
	 * @param lists The compute times measured under each key.
	 * @returns One row per key, slowest median first.
	 */
	private static _stageGroupRows(lists: Map<string, number[]>): StageGroupRow[] {
		return [...lists.entries()]
			.map(([key, values]: [string, number[]]): StageGroupRow => ({
				key,
				count: values.length,
				computeMs: LogStatistics.distribution(values),
			}))
			.sort((left: StageGroupRow, right: StageGroupRow): number => right.computeMs.median - left.computeMs.median);
	}

	/**
	 * Reports whether a message type names something going wrong.
	 *
	 * @param messageType The message's `type` field.
	 * @returns `true` when the type mentions a failure, a rejection, or a cancellation.
	 */
	private static _isFailureMessageType(messageType: string): boolean {
		const lowercase: string = messageType.toLowerCase();
		return failureWords.some((word: string): boolean => lowercase.includes(word));
	}

	/**
	 * Reads one percentile out of an already-sorted set of measurements, by nearest rank.
	 *
	 * @param sorted Every measurement, smallest first, holding at least one value.
	 * @param fraction The share of measurements that must fall at or below the answer, from 0 to 1.
	 * @returns The measured value at that rank.
	 */
	private static _percentile(sorted: number[], fraction: number): number {
		const rank: number = Math.ceil(fraction * sorted.length);
		const index: number = Math.min(sorted.length - 1, Math.max(0, rank - 1));
		return sorted[index] ?? 0;
	}
}
