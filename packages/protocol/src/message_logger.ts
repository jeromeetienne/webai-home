import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Whether a logged message was received from, or sent to, the counterpart. */
export type LogDirection = "received" | "sent";

/** The other side of a logged message. */
export interface LogCounterpart {
	/** The counterpart's role ("consumer", "worker", "observer", "gateway", or "unknown" before it has registered). */
	role: string;
	/** The counterpart's device identifier, when one has been assigned. */
	deviceId?: string;
}

/** One line written to an actor's message log. */
export interface LogEntry {
	/** The moment the message was received or sent, in ISO 8601 format with milliseconds. */
	timestamp: string;
	/** Whether the message was received from, or sent to, the counterpart. */
	direction: LogDirection;
	/** The other side of the message. */
	counterpart: LogCounterpart;
	/** The message's `type` field, e.g. "task.submit" or "stage.assign". */
	messageType: string;
	/** The full message body. */
	payload: unknown;
	/** Exact UTF-8 byte size of the JSON message body when the entry was recorded. */
	payloadBytes?: number;
	/** Exact UTF-8 byte size of the message envelope and body when recorded. */
	messageBytes?: number;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MessageLogger — appends one JSON line per sent or received message to a log file
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Records every message one actor (consumer, gateway, or worker) sends and receives, as one
 * JSON object per line, so message traffic between actors can be reviewed afterward.
 *
 * Node.js only — a browser worker client cannot write files itself and instead relays
 * its log entries to the gateway over the existing connection (see the `log.entry` client
 * message in `index.ts`), which appends them to that worker's own log file on its behalf.
 */
export class MessageLogger {
	private readonly logFilePath: string;

	/**
	 * @param logFilePath Path to the JSON Lines file this logger appends to. Its parent
	 * directory is created automatically if it does not already exist.
	 */
	constructor(logFilePath: string) {
		this.logFilePath = logFilePath;
		mkdirSync(dirname(logFilePath), { recursive: true });
	}

	/**
	 * Appends one log entry.
	 *
	 * @param direction Whether the message was received from, or sent to, the counterpart.
	 * @param counterpart The other side of the message.
	 * @param messageType The message's `type` field.
	 * @param payload The full message body.
	 * @param timestamp The moment the message was received or sent. Defaults to now; a
	 * worker-relayed entry passes the moment it actually happened in the browser instead.
	 */
	log(
		direction: LogDirection,
		counterpart: LogCounterpart,
		messageType: string,
		payload: unknown,
		timestamp: string = new Date().toISOString(),
	): void {
		const message = typeof payload === "object" && payload !== null ? payload : { type: messageType, value: payload };
		const payloadWithoutType = typeof payload === "object" && payload !== null && !Array.isArray(payload)
			? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => key !== "type"))
			: payload;
		const payloadBytes = Buffer.byteLength(JSON.stringify(payloadWithoutType), "utf8");
		const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
		const entry: LogEntry = { timestamp, direction, counterpart, messageType, payload, payloadBytes, messageBytes };
		appendFileSync(this.logFilePath, `${JSON.stringify(entry)}\n`, "utf-8");
	}
}
