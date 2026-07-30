import type { LogDirection, LogEntry } from "@webai/protocol/message_logger";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types — shapes shared across the parser, model, view, and playback controller
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Which side of the diagram an actor node is drawn in. */
export type LaneColumn = "left" | "center" | "right";

/** What an event is about, used to decide default visibility and packet color. */
export type EventCategory = "task" | "chatter" | "signaling";

/** One participant drawn in the diagram: the gateway itself, a consumer, or a worker. */
export interface ActorNode {
	id: string;
	role: string;
	deviceId: string | undefined;
	label: string;
	sublabel: string | undefined;
	column: LaneColumn;
	row: number;
	firstSeenMs: number;
}

/** One animated, filterable message crossing the diagram between two actor nodes. */
export interface TimelineEvent {
	index: number;
	timestampMs: number;
	/** The complete log entry represented by this event, including its payload. */
	logEntry: LogEntry;
	direction: LogDirection;
	fromActorId: string;
	toActorId: string;
	messageType: string;
	/** A full sentence naming what the message does, shown in the event log list. */
	summary: string;
	/**
	 * A short label drawn under the message type on the animated packet, naming the one
	 * thing that distinguishes this message from the others of its type — the stage name,
	 * the new task state, an identifier. Undefined when the message type already says it all.
	 */
	detail: string | undefined;
	taskId: string | undefined;
	/**
	 * The message type of the request this message answers, when the log records the
	 * identifiers that say so. Undefined for a message the gateway pushed on its own, and for
	 * every message in a log recorded before those identifiers existed.
	 */
	answersMessageType: string | undefined;
	category: EventCategory;
}

/** An inclusive millisecond time span, used for the datetime range pickers and the scrubber. */
export interface TimeRangeMs {
	fromMs: number;
	toMs: number;
}

/** Which optional, high-volume message categories are currently shown. */
export interface CategoryFilters {
	showChatter: boolean;
	showSignaling: boolean;
}

/** Pixel position of a rendered actor node, used to draw guide lines and animate packets. */
export interface ActorPosition {
	x: number;
	y: number;
}

/**
 * One loaded log file: the entries it recorded from its own point of view (e.g. one
 * gateway run, or one consumer run), identified so several files can be merged into a single
 * diagram while still showing each as its own node — e.g. one node per gateway restart.
 */
export interface LogSource {
	id: string;
	label: string;
	entries: LogEntry[];
}

/** The diagram and playback settings a CLI-launched session starts with, before any clicking. */
export interface InitialUiState {
	fromMs: number;
	toMs: number;
	showChatter: boolean;
	showSignaling: boolean;
	speed: number;
	autoplay: boolean;
}

/** What the CLI serves the page on startup: the merged log data, and how to start displaying it. */
export interface SessionPayload {
	sources: LogSource[];
	initialState: InitialUiState;
}
