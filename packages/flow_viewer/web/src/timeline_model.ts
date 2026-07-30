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

interface DevicesPayload {
	devices?: Array<{ deviceId?: string; name?: string; deviceRole?: string }>;
}

interface TaskSubmitPayload {
	requestId?: string;
	input?: { taskType?: string; input?: unknown } | string;
}

/**
 * A recorded message that carries a task.
 *
 * `task.accepted`, `task.snapshot`, and older recordings of `task.updated` put the task
 * under `task`. Current recordings of `task.updated` put the slim projection under
 * `update` instead, so both field names are read here and logs recorded before that
 * change still render.
 */
interface TaskLikePayload {
	task?: TaskLikeFields;
	update?: TaskLikeFields;
}

/** The task fields the timeline reads, whichever field of a message carries them. */
interface TaskLikeFields {
	taskId?: string;
	state?: string;
	error?: string;
	pipelineId?: string;
	pipelineVersion?: number;
	revision?: number;
}

interface StageAssignPayload {
	taskId?: string;
	assignmentId?: string;
	attempt?: number;
	stage?: string;
}

interface StageResultPayload {
	taskId?: string;
	assignmentId?: string;
	attempt?: number;
	stage?: string;
}

interface StageResultAcceptedPayload {
	taskId?: string;
	assignmentId?: string;
	attempt?: number;
	revision?: number;
	status?: string;
}

interface StageFailedPayload {
	taskId?: string;
	assignmentId?: string;
	attempt?: number;
	stage?: string;
	error?: string;
}

interface AssignmentPayload {
	taskId?: string;
	assignmentId?: string;
	attempt?: number;
}

interface ErrorPayload {
	message?: string;
}

/** The two texts written for one message: a full sentence for the event log list, and a short label for the animated packet. */
interface EventDescription {
	summary: string;
	detail: string | undefined;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Constants
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// The marker `MessageLogger.redactPayload` writes in place of a task input, a stage value,
// a task result, or an authentication token, at any depth in a logged message.
// Kept as a literal because importing it from `@webai/protocol/message_logger`
// would pull that module's Node.js file-system imports into the browser bundle.
const REDACTED_MARKER = "[redacted]";

// The animated packet's label is drawn centred on a dot travelling between the lane
// columns, so both of its lines must stay short enough never to run past the edge of
// the diagram or across a neighbouring actor node.
const MAX_PACKET_DETAIL_LENGTH = 28;
// How many leading characters of an identifier are enough to recognise it at a glance.
const SHORT_IDENTIFIER_LENGTH = 8;
const IDENTIFIER_PREFIXES: readonly string[] = ["task-", "assignment-", "device-"];

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

// Connection setup is not task traffic. Keeping authentication in chatter also
// prevents pre-registration `unknown` counterparts from becoming actor nodes
// when the viewer is using its default filters.
const CHATTER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
	"authenticate",
	"authenticated",
	"register",
	"registered",
	"devices",
	"device.joined",
	"device.updated",
	"device.left",
]);
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
		const nameByActorId: Map<string, string> = new Map();

		for (const source of sources) {
			const selfActorId = `gateway:${source.id}`;
			// Diagnostic reporting no longer travels on the scheduling connection at all, but a
			// log recorded before that change still contains it, and it is not wire traffic.
			const wireEntries: LogEntry[] = source.entries.filter((entry: LogEntry): boolean => entry.messageType !== "log.entry");
			const answeredRequests: Map<number, number> = TimelineModel._resolveAnsweredRequests(wireEntries);
			const submitTaskIds: Map<number, string> = TimelineModel._resolveSubmitTaskIds(wireEntries, answeredRequests);
			const roleByDeviceId: Map<string, string> = TimelineModel._resolveDeviceRoles(wireEntries);

			for (const [entryIndex, entry] of wireEntries.entries()) {
				const timestampMs: number = Date.parse(entry.timestamp);

				const counterpartRole: string = roleByDeviceId.get(entry.counterpart.deviceId ?? "") ?? entry.counterpart.role;
				const counterpartActorId: string = TimelineModel._actorId(counterpartRole, entry.counterpart.deviceId);
				TimelineModel._recordFirstSeen(firstSeenByActorId, counterpartActorId, timestampMs);
				TimelineModel._recordFirstSeen(firstSeenByActorId, selfActorId, timestampMs);
				if (entry.messageType === "register" && entry.counterpart.deviceId !== undefined) {
					const registerPayload = entry.payload as RegisterPayload;
					if (registerPayload.name !== undefined) nameByActorId.set(counterpartActorId, registerPayload.name);
				}
				if (entry.messageType === "devices") {
					const devicesPayload = entry.payload as DevicesPayload;
					for (const device of devicesPayload.devices ?? []) {
						if (device.deviceId !== undefined && device.name !== undefined && device.deviceRole !== undefined) {
							nameByActorId.set(TimelineModel._actorId(device.deviceRole, device.deviceId), device.name);
						}
					}
				}

				if (timestampMs < range.fromMs || timestampMs > range.toMs) continue;

				const category: EventCategory = TimelineModel._categorize(entry.messageType);
				if (category === "chatter" && !filters.showChatter) continue;
				if (category === "signaling" && !filters.showSignaling) continue;

				const taskId: string | undefined = submitTaskIds.get(entryIndex) ?? TimelineModel._extractTaskId(entry);
				const fromActorId: string = entry.direction === "received" ? counterpartActorId : selfActorId;
				const toActorId: string = entry.direction === "received" ? selfActorId : counterpartActorId;
				const description: EventDescription = TimelineModel._describe(entry.messageType, entry.payload);
				const answeredIndex: number | undefined = answeredRequests.get(entryIndex);

				events.push({
					index: events.length,
					timestampMs,
					logEntry: entry,
					direction: entry.direction,
					fromActorId,
					toActorId,
					messageType: entry.messageType,
					summary: description.summary,
					detail: description.detail,
					taskId,
					answersMessageType: answeredIndex === undefined ? undefined : wireEntries[answeredIndex]?.messageType,
					category,
				});
			}
		}

		events.sort((a: TimelineEvent, b: TimelineEvent): number => a.timestampMs - b.timestampMs);
		return { actors: TimelineModel._buildActors(sources, events, firstSeenByActorId, nameByActorId), events };
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

	/** Resolves a connection's temporary `unknown` role from its later registered traffic. */
	private static _resolveDeviceRoles(entries: LogEntry[]): Map<string, string> {
		const roles = new Map<string, string>();
		for (const entry of entries) {
			const deviceId = entry.counterpart.deviceId;
			const role = entry.counterpart.role;
			if (deviceId !== undefined && role !== "unknown") roles.set(deviceId, role);
			if (entry.messageType !== "devices") continue;
			const devices = (entry.payload as DevicesPayload).devices ?? [];
			for (const device of devices) {
				if (device.deviceId !== undefined && device.deviceRole !== undefined) roles.set(device.deviceId, device.deviceRole);
			}
		}
		return roles;
	}

	private static _categorize(messageType: string): EventCategory {
		if (CHATTER_MESSAGE_TYPES.has(messageType)) return "chatter";
		if (SIGNALING_MESSAGE_TYPES.has(messageType)) return "signaling";
		return "task";
	}

	/**
	 * Matches each recorded answer to the request it answers.
	 *
	 * A message recorded with the wrapper carries its own identifier, and an answer carries
	 * the identifier of the request it answers, so this is a lookup. A log recorded before
	 * the wrapper existed carries neither, and those entries are simply absent from the
	 * result; every caller falls back to what it did before.
	 *
	 * @param wireEntries - The recorded messages, in the order they were recorded.
	 * @returns For each answer's position, the position of the request it answers.
	 */
	private static _resolveAnsweredRequests(wireEntries: LogEntry[]): Map<number, number> {
		const indexByMessageId: Map<string, number> = new Map();
		for (const [entryIndex, entry] of wireEntries.entries()) {
			if (entry.messageId !== undefined) indexByMessageId.set(entry.messageId, entryIndex);
		}

		const answered: Map<number, number> = new Map();
		for (const [entryIndex, entry] of wireEntries.entries()) {
			if (entry.inReplyTo === undefined) continue;
			const requestIndex: number | undefined = indexByMessageId.get(entry.inReplyTo);
			if (requestIndex !== undefined) answered.set(entryIndex, requestIndex);
		}
		return answered;
	}

	/**
	 * `task.submit` carries no task identifier of its own — the gateway mints one and
	 * returns it in the `task.accepted` answer.
	 *
	 * When the log records the wrapper, the answer names the request it answers and this is a
	 * lookup. A log recorded before the wrapper existed carries no identifiers, so each submit
	 * is instead matched with the next `task.accepted` sent back to the same device, which is
	 * what this did before and is wrong whenever two submissions are in flight at once.
	 *
	 * @param wireEntries - The recorded messages, in the order they were recorded.
	 * @param answeredRequests - For each answer's position, the position of its request.
	 * @returns For each `task.submit` position, the identifier of the task it created.
	 */
	private static _resolveSubmitTaskIds(wireEntries: LogEntry[], answeredRequests: Map<number, number>): Map<number, string> {
		const resolved: Map<number, string> = new Map();

		for (const [answerIndex, requestIndex] of answeredRequests) {
			const answer: LogEntry = wireEntries[answerIndex]!;
			if (answer.messageType !== "task.accepted") continue;
			if (wireEntries[requestIndex]?.messageType !== "task.submit") continue;
			const taskId: string | undefined = TimelineModel._taskLikeFields(answer.payload).taskId;
			if (taskId !== undefined) resolved.set(requestIndex, taskId);
		}

		for (const [submitIndex, submitEntry] of wireEntries.entries()) {
			if (submitEntry.messageType !== "task.submit" || submitEntry.direction !== "received") continue;
			if (resolved.has(submitIndex)) continue;

			for (let candidateIndex = submitIndex + 1; candidateIndex < wireEntries.length; candidateIndex++) {
				const candidate: LogEntry = wireEntries[candidateIndex]!;
				const isMatchingReply: boolean =
					candidate.messageType === "task.accepted" &&
					candidate.direction === "sent" &&
					candidate.counterpart.deviceId === submitEntry.counterpart.deviceId;
				if (!isMatchingReply) continue;

				const taskId: string | undefined = TimelineModel._taskLikeFields(candidate.payload).taskId;
				if (taskId !== undefined) resolved.set(submitIndex, taskId);
				break;
			}
		}

		return resolved;
	}

	/**
	 * Reads the task fields of a recorded message, from whichever field carries them.
	 *
	 * @param payload - The recorded message payload.
	 * @returns The task fields, or an empty object when the payload carries no task.
	 */
	private static _taskLikeFields(payload: unknown): TaskLikeFields {
		const taskPayload = payload as TaskLikePayload;
		return taskPayload.update ?? taskPayload.task ?? {};
	}

	private static _extractTaskId(entry: LogEntry): string | undefined {
		switch (entry.messageType) {
			case "task.accepted":
			case "task.snapshot":
			case "task.updated":
				return TimelineModel._taskLikeFields(entry.payload).taskId;
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

	/**
	 * Writes both texts shown for one message: the full sentence listed beside the diagram,
	 * and the short label drawn under the message type on the packet crossing the diagram.
	 */
	private static _describe(messageType: string, payload: unknown): EventDescription {
		const shortDetail = (detail: string): string => TimelineModel._truncate(detail, MAX_PACKET_DETAIL_LENGTH);

		switch (messageType) {
			case "register": {
				const registerPayload = payload as RegisterPayload;
				const name: string = registerPayload.name ?? "unnamed";
				return { summary: `registers as ${registerPayload.role ?? "an unknown role"} (${name})`, detail: shortDetail(name) };
			}
			case "registered":
				return { summary: "confirms registration", detail: undefined };
			case "devices":
				return { summary: "sends the current device list", detail: undefined };
			case "task.submit": {
				const submitPayload = payload as TaskSubmitPayload;
				const taskInput = typeof submitPayload.input === "object" && submitPayload.input !== null ? submitPayload.input : undefined;
				const submittedValue: unknown = taskInput === undefined ? submitPayload.input : taskInput.input;
				const valueText: string = submittedValue === undefined ? "" : `: ${submittedValue === REDACTED_MARKER ? REDACTED_MARKER : JSON.stringify(submittedValue)}`;
				const requestText: string = submitPayload.requestId === undefined ? "" : ` (request ${submitPayload.requestId})`;
				return {
					summary: `submits a ${taskInput?.taskType ?? "task"}${valueText}${requestText}`,
					detail: shortDetail(taskInput?.taskType ?? `request ${TimelineModel._shortIdentifier(submitPayload.requestId)}`),
				};
			}
			case "task.accepted": {
				const taskFields = TimelineModel._taskLikeFields(payload);
				const pipeline = taskFields.pipelineId === undefined ? "" : ` using ${taskFields.pipelineId}@${taskFields.pipelineVersion ?? "?"}`;
				return {
					summary: `accepts task ${TimelineModel._shortIdentifier(taskFields.taskId)} (${taskFields.state ?? "queued"})${pipeline}`,
					detail: shortDetail(`task ${TimelineModel._shortIdentifier(taskFields.taskId)}`),
				};
			}
			case "task.snapshot": {
				const taskFields = TimelineModel._taskLikeFields(payload);
				return {
					summary: `sends the full state of task ${TimelineModel._shortIdentifier(taskFields.taskId)} (${taskFields.state ?? "unknown"})`,
					detail: shortDetail(`task ${TimelineModel._shortIdentifier(taskFields.taskId)}`),
				};
			}
			case "task.updated": {
				const taskFields = TimelineModel._taskLikeFields(payload);
				const state = taskFields.state ?? "unknown";
				const errorSuffix = taskFields.error !== undefined ? `: ${taskFields.error}` : "";
				const revision = taskFields.revision === undefined ? "" : ` (revision ${taskFields.revision})`;
				return {
					summary: `updates task ${TimelineModel._shortIdentifier(taskFields.taskId)} to ${state}${revision}${errorSuffix}`,
					detail: shortDetail(`now ${state}`),
				};
			}
			case "stage.assign": {
				const stagePayload = payload as StageAssignPayload;
				return {
					summary: `assigns ${stagePayload.stage ?? "a stage"} for task ${TimelineModel._shortIdentifier(stagePayload.taskId)}${stagePayload.assignmentId === undefined ? "" : ` (assignment ${stagePayload.assignmentId}, attempt ${stagePayload.attempt ?? "?"})`}`,
					detail: shortDetail(stagePayload.stage ?? "a stage"),
				};
			}
			case "stage.result": {
				const stagePayload = payload as StageResultPayload;
				return {
					summary: `reports ${stagePayload.stage ?? "a stage"} finished for task ${TimelineModel._shortIdentifier(stagePayload.taskId)}${stagePayload.assignmentId === undefined ? "" : ` (assignment ${stagePayload.assignmentId}, attempt ${stagePayload.attempt ?? "?"})`}`,
					detail: shortDetail(stagePayload.stage ?? "a stage"),
				};
			}
			case "stage.result.accepted": {
				const acceptedPayload = payload as StageResultAcceptedPayload;
				const revision = acceptedPayload.revision === undefined ? "" : ` (revision ${acceptedPayload.revision})`;
				return {
					summary: `accepts the result of assignment ${acceptedPayload.assignmentId ?? "?"} for task ${TimelineModel._shortIdentifier(acceptedPayload.taskId)}, now ${acceptedPayload.status ?? "unknown"}${revision}`,
					detail: shortDetail(`now ${acceptedPayload.status ?? "unknown"}`),
				};
			}
			case "stage.accepted": {
				const assignment = payload as AssignmentPayload;
				return {
					summary: `accepts assignment ${assignment.assignmentId ?? "?"} (attempt ${assignment.attempt ?? "?"}) for task ${TimelineModel._shortIdentifier(assignment.taskId)}`,
					detail: shortDetail(`assignment ${TimelineModel._shortIdentifier(assignment.assignmentId)}`),
				};
			}
			case "stage.relinquish": {
				const assignment = payload as AssignmentPayload;
				return {
					summary: `relinquishes assignment ${assignment.assignmentId ?? "?"} for task ${TimelineModel._shortIdentifier(assignment.taskId)}`,
					detail: shortDetail(`assignment ${TimelineModel._shortIdentifier(assignment.assignmentId)}`),
				};
			}
			case "stage.cancel": {
				const assignment = payload as AssignmentPayload;
				return {
					summary: `cancels assignment ${assignment.assignmentId ?? "?"} for task ${TimelineModel._shortIdentifier(assignment.taskId)}`,
					detail: shortDetail(`assignment ${TimelineModel._shortIdentifier(assignment.assignmentId)}`),
				};
			}
			case "task.cancel": {
				const assignment = payload as AssignmentPayload;
				return {
					summary: `cancels task ${TimelineModel._shortIdentifier(assignment.taskId)}`,
					detail: shortDetail(`task ${TimelineModel._shortIdentifier(assignment.taskId)}`),
				};
			}
			case "stage.failed": {
				const stagePayload = payload as StageFailedPayload;
				return {
					summary: `reports ${stagePayload.stage ?? "a stage"} failed for task ${TimelineModel._shortIdentifier(stagePayload.taskId)}${stagePayload.assignmentId === undefined ? "" : ` (assignment ${stagePayload.assignmentId}, attempt ${stagePayload.attempt ?? "?"})`}: ${stagePayload.error ?? "no reason given"}`,
					detail: shortDetail(stagePayload.stage ?? "a stage"),
				};
			}
			case "signal":
				return { summary: "relays peer connection signaling data", detail: undefined };
			case "error": {
				const message: string = (payload as ErrorPayload).message ?? "no message given";
				return { summary: `reports an error: ${message}`, detail: shortDetail(message) };
			}
			default:
				return { summary: messageType, detail: undefined };
		}
	}

	/** Shortens an identifier to the leading characters that make it recognisable at a glance. */
	private static _shortIdentifier(identifier: string | undefined): string {
		if (identifier === undefined) return "?";
		const prefix: string | undefined = IDENTIFIER_PREFIXES.find((candidate: string): boolean => identifier.startsWith(candidate));
		const withoutPrefix: string = prefix === undefined ? identifier : identifier.slice(prefix.length);
		return withoutPrefix.slice(0, SHORT_IDENTIFIER_LENGTH);
	}

	/** Cuts text down to a maximum length, marking the cut with an ellipsis. */
	private static _truncate(text: string, maxLength: number): string {
		return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
	}

	private static _buildActors(
		sources: LogSource[],
		events: TimelineEvent[],
		firstSeenByActorId: Map<string, number>,
		nameByActorId: Map<string, string>,
	): ActorNode[] {
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
				sublabel: nameByActorId.get(actorId) ?? (deviceId !== undefined ? deviceId.replace("device-", "").slice(0, 8) : undefined),
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
