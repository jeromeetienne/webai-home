import type { LogEntry } from "@webai/protocol/message_logger";
import type { ActorNode, CategoryFilters, EventCategory, LaneColumn, LogSource, TimeRangeMs, TimelineEvent } from "./types.js";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types — the minimal payload shapes this model reads out of `LogEntry.payload`
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

interface RegisterPayload {
	role?: string;
	name?: string;
}

interface TaskSubmitPayload {
	input?: { taskType?: string; input?: unknown };
}

interface TaskLikePayload {
	task?: { taskId?: string; state?: string; error?: string };
}

interface StageAssignPayload {
	taskId?: string;
	stage?: string;
}

interface StageResultPayload {
	taskId?: string;
	stage?: string;
}

interface StageFailedPayload {
	taskId?: string;
	stage?: string;
	error?: string;
}

interface ErrorPayload {
	message?: string;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Constants
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const NEUTRAL_PACKET_COLOR = "#64748b";
const TASK_COLOR_PALETTE: readonly string[] = [
	"#38bdf8",
	"#f97316",
	"#22c55e",
	"#e879f9",
	"#facc15",
	"#f43f5e",
	"#a78bfa",
	"#2dd4bf",
];

const CHATTER_MESSAGE_TYPES: ReadonlySet<string> = new Set(["register", "registered", "devices"]);
const SIGNALING_MESSAGE_TYPES: ReadonlySet<string> = new Set(["signal"]);

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TimelineModel — builds the actor lanes and animated events shown in the diagram
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Turns one or more merged log sources into the actor nodes and timeline events the
 * diagram animates. Each source (typically one gateway run's log file) gets its own
 * gateway node in the center lane, so several runs can be viewed side by side; every
 * distinct consumer or worker device gets its own node too, so each is clearly
 * separated from the others. Resolves each message's task identifier where the wire
 * protocol does not carry one directly (`task.submit`), and assigns a stable color per
 * task so a viewer can visually follow one task's whole journey.
 */
export class TimelineModel {
	/**
	 * @param sources Every loaded log source, each with its entries in ascending timestamp
	 * order, unfiltered by time range — the full entries are needed so a `task.submit` can
	 * be matched with the `task.accepted` that names its task identifier, even near a range
	 * boundary.
	 */
	static build(sources: LogSource[], range: TimeRangeMs, filters: CategoryFilters): { actors: ActorNode[]; events: TimelineEvent[] } {
		const events: TimelineEvent[] = [];
		const firstSeenByActorId: Map<string, number> = new Map();

		for (const source of sources) {
			const selfActorId = `gateway:${source.id}`;
			const wireEntries: LogEntry[] = source.entries.filter((entry: LogEntry): boolean => entry.messageType !== "log.entry");
			const submitTaskIds: Map<number, string> = TimelineModel._resolveSubmitTaskIds(wireEntries);

			for (const [entryIndex, entry] of wireEntries.entries()) {
				const timestampMs: number = Date.parse(entry.timestamp);

				const counterpartActorId: string = TimelineModel._actorId(entry.counterpart.role, entry.counterpart.deviceId);
				TimelineModel._recordFirstSeen(firstSeenByActorId, counterpartActorId, timestampMs);
				TimelineModel._recordFirstSeen(firstSeenByActorId, selfActorId, timestampMs);

				if (timestampMs < range.fromMs || timestampMs > range.toMs) continue;

				const category: EventCategory = TimelineModel._categorize(entry.messageType);
				if (category === "chatter" && !filters.showChatter) continue;
				if (category === "signaling" && !filters.showSignaling) continue;

				const taskId: string | undefined = submitTaskIds.get(entryIndex) ?? TimelineModel._extractTaskId(entry);
				const fromActorId: string = entry.direction === "received" ? counterpartActorId : selfActorId;
				const toActorId: string = entry.direction === "received" ? selfActorId : counterpartActorId;

				events.push({
					index: events.length,
					timestampMs,
					direction: entry.direction,
					fromActorId,
					toActorId,
					messageType: entry.messageType,
					summary: TimelineModel._describe(entry.messageType, entry.payload),
					taskId,
					category,
				});
			}
		}

		events.sort((a: TimelineEvent, b: TimelineEvent): number => a.timestampMs - b.timestampMs);
		return { actors: TimelineModel._buildActors(sources, events, firstSeenByActorId), events };
	}

	/** Computes the full time span covered by every source's entries, regardless of any filter. */
	static computeFullRangeMs(sources: LogSource[]): TimeRangeMs | undefined {
		const timestamps: number[] = sources.flatMap((source: LogSource): number[] => source.entries.map((entry: LogEntry): number => Date.parse(entry.timestamp)));
		if (timestamps.length === 0) return undefined;
		return { fromMs: Math.min(...timestamps), toMs: Math.max(...timestamps) };
	}

	/** A stable color for a task identifier, or the neutral gray used for task-less chatter. */
	static colorForTaskId(taskId: string | undefined): string {
		if (taskId === undefined) return NEUTRAL_PACKET_COLOR;
		let hash = 0;
		for (let charIndex = 0; charIndex < taskId.length; charIndex++) {
			hash = (hash * 31 + taskId.charCodeAt(charIndex)) | 0;
		}
		const paletteIndex: number = Math.abs(hash) % TASK_COLOR_PALETTE.length;
		return TASK_COLOR_PALETTE[paletteIndex] ?? NEUTRAL_PACKET_COLOR;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	private static _recordFirstSeen(firstSeenByActorId: Map<string, number>, actorId: string, timestampMs: number): void {
		const existing: number | undefined = firstSeenByActorId.get(actorId);
		if (existing === undefined || timestampMs < existing) firstSeenByActorId.set(actorId, timestampMs);
	}

	private static _actorId(role: string, deviceId: string | undefined): string {
		return deviceId !== undefined ? `${role}:${deviceId}` : `${role}:unregistered`;
	}

	private static _categorize(messageType: string): EventCategory {
		if (CHATTER_MESSAGE_TYPES.has(messageType)) return "chatter";
		if (SIGNALING_MESSAGE_TYPES.has(messageType)) return "signaling";
		return "task";
	}

	/**
	 * `task.submit` carries no task identifier of its own — the gateway mints one and
	 * returns it in the `task.accepted` reply. This matches each submit with the next
	 * `task.accepted` sent back to the same device, so the submit can still be colored
	 * and grouped with the rest of its task's events.
	 */
	private static _resolveSubmitTaskIds(wireEntries: LogEntry[]): Map<number, string> {
		const resolved: Map<number, string> = new Map();

		for (const [submitIndex, submitEntry] of wireEntries.entries()) {
			if (submitEntry.messageType !== "task.submit" || submitEntry.direction !== "received") continue;

			for (let candidateIndex = submitIndex + 1; candidateIndex < wireEntries.length; candidateIndex++) {
				const candidate: LogEntry = wireEntries[candidateIndex]!;
				const isMatchingReply: boolean =
					candidate.messageType === "task.accepted" &&
					candidate.direction === "sent" &&
					candidate.counterpart.deviceId === submitEntry.counterpart.deviceId;
				if (!isMatchingReply) continue;

				const taskId: string | undefined = (candidate.payload as TaskLikePayload).task?.taskId;
				if (taskId !== undefined) resolved.set(submitIndex, taskId);
				break;
			}
		}

		return resolved;
	}

	private static _extractTaskId(entry: LogEntry): string | undefined {
		switch (entry.messageType) {
			case "task.accepted":
			case "task.updated":
				return (entry.payload as TaskLikePayload).task?.taskId;
			case "stage.assign":
				return (entry.payload as StageAssignPayload).taskId;
			case "stage.result":
				return (entry.payload as StageResultPayload).taskId;
			case "stage.failed":
				return (entry.payload as StageFailedPayload).taskId;
			default:
				return undefined;
		}
	}

	private static _describe(messageType: string, payload: unknown): string {
		const shortTaskId = (taskId: string | undefined): string => (taskId !== undefined ? taskId.replace("task-", "").slice(0, 8) : "?");

		switch (messageType) {
			case "register": {
				const registerPayload = payload as RegisterPayload;
				return `registers as ${registerPayload.role ?? "an unknown role"} (${registerPayload.name ?? "unnamed"})`;
			}
			case "registered":
				return "confirms registration";
			case "devices":
				return "sends the current device list";
			case "task.submit": {
				const submitPayload = payload as TaskSubmitPayload;
				return `submits a ${submitPayload.input?.taskType ?? "task"}: ${JSON.stringify(submitPayload.input?.input)}`;
			}
			case "task.accepted": {
				const taskPayload = payload as TaskLikePayload;
				return `accepts task ${shortTaskId(taskPayload.task?.taskId)} (${taskPayload.task?.state ?? "queued"})`;
			}
			case "task.updated": {
				const taskPayload = payload as TaskLikePayload;
				const state = taskPayload.task?.state ?? "unknown";
				const errorSuffix = taskPayload.task?.error !== undefined ? `: ${taskPayload.task.error}` : "";
				return `updates task ${shortTaskId(taskPayload.task?.taskId)} to ${state}${errorSuffix}`;
			}
			case "stage.assign": {
				const stagePayload = payload as StageAssignPayload;
				return `assigns ${stagePayload.stage ?? "a stage"} for task ${shortTaskId(stagePayload.taskId)}`;
			}
			case "stage.result": {
				const stagePayload = payload as StageResultPayload;
				return `reports ${stagePayload.stage ?? "a stage"} finished for task ${shortTaskId(stagePayload.taskId)}`;
			}
			case "stage.failed": {
				const stagePayload = payload as StageFailedPayload;
				return `reports ${stagePayload.stage ?? "a stage"} failed for task ${shortTaskId(stagePayload.taskId)}: ${stagePayload.error ?? "no reason given"}`;
			}
			case "signal":
				return "relays peer connection signaling data";
			case "error":
				return `reports an error: ${(payload as ErrorPayload).message ?? "no message given"}`;
			default:
				return messageType;
		}
	}

	private static _buildActors(sources: LogSource[], events: TimelineEvent[], firstSeenByActorId: Map<string, number>): ActorNode[] {
		const visibleActorIds: Set<string> = new Set<string>();
		for (const event of events) {
			visibleActorIds.add(event.fromActorId);
			visibleActorIds.add(event.toActorId);
		}

		const sourceLabelById: Map<string, string> = new Map(sources.map((source: LogSource): [string, string] => [source.id, source.label]));

		const actors: ActorNode[] = [];
		for (const actorId of visibleActorIds) {
			const [kind, idPart] = actorId.split(":") as [string, string];

			if (kind === "gateway") {
				actors.push({
					id: actorId,
					role: "gateway",
					deviceId: undefined,
					label: sourceLabelById.get(idPart) ?? "Gateway",
					sublabel: undefined,
					column: "center",
					row: 0,
					firstSeenMs: firstSeenByActorId.get(actorId) ?? 0,
				});
				continue;
			}

			const deviceId: string | undefined = idPart === "unregistered" ? undefined : idPart;
			const column: LaneColumn = kind === "worker" ? "right" : "left";
			actors.push({
				id: actorId,
				role: kind,
				deviceId,
				label: kind === "consumer" ? "Consumer" : kind === "worker" ? "Worker" : "Unregistered device",
				sublabel: deviceId !== undefined ? deviceId.replace("device-", "").slice(0, 8) : undefined,
				column,
				row: 0,
				firstSeenMs: firstSeenByActorId.get(actorId) ?? 0,
			});
		}

		const byColumn = (column: LaneColumn): ActorNode[] =>
			actors
				.filter((actor: ActorNode): boolean => actor.column === column)
				.sort((a: ActorNode, b: ActorNode): number => a.firstSeenMs - b.firstSeenMs);

		const columns: LaneColumn[] = ["left", "center", "right"];
		const orderedActors: ActorNode[] = [];
		for (const column of columns) {
			const columnActors: ActorNode[] = byColumn(column);
			columnActors.forEach((actor: ActorNode, row: number): void => {
				actor.row = row;
			});
			orderedActors.push(...columnActors);
		}

		return orderedActors;
	}
}
