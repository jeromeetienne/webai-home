import Fs from 'node:fs';
import Path from 'node:path';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Whether a logged message was received from, or sent to, the counterpart. */
export type LogDirection = 'received' | 'sent';

/**
 * The property names whose value is a credential, and is therefore never written to a log
 * file.
 *
 * `token` is the authentication token sent in the `deviceAuthenticate` message. Unlike task
 * content, a leaked credential is a security incident regardless of who reads the log, so this
 * stays redacted even where log files are kept for local debugging.
 */
const redactedKeyNames = new Set(['token']);

/** The marker written in place of a redacted value. */
const redactedMarker = '[redacted]';

/**
 * How deep the redaction walk descends before it replaces the remaining structure wholesale.
 *
 * A message that nests more deeply than this is either malformed or hostile, and a log entry
 * is not worth an unbounded walk.
 */
const maximumRedactionDepth = 12;

/** The other side of a logged message. */
export type LogCounterpart = {
	/** The counterpart's role ("consumer", "worker", "observer", "gateway", or "unknown" before it has registered). */
	role: string;
	/** The counterpart's device identifier, when one has been assigned. */
	deviceId?: string;
};

/** One line written to an actor's message log. */
export type LogEntry = {
	/** The moment the message was received or sent, in ISO 8601 format with milliseconds. */
	timestamp: string;
	/** Whether the message was received from, or sent to, the counterpart. */
	direction: LogDirection;
	/** The other side of the message. */
	counterpart: LogCounterpart;
	/** The message's `type` field, e.g. "task.submit" or "stage.assign". */
	messageType: string;
	/** The full message body. */
	messagePayload: unknown;
	/** The identifier of the frame this message travelled in. */
	messageId?: string;
	/** The identifier of the request this message answers, when it answers one. */
	inReplyToMessageId?: string;
	/** The protocol version the frame stated. */
	protocolVersion?: number;
	/** Exact UTF-8 byte size of the JSON message body when the entry was recorded. */
	messagePayloadBytes?: number;
	/** Exact UTF-8 byte size of the message envelope and body when recorded. */
	messageBytes?: number;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MessageLogger — appends one JSON line per sent or received message to a log file
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Records every message one actor (consumer, gateway, or worker) sends and receives, as one
 * JSON object per line, so message traffic between actors can be reviewed afterward.
 *
 * Node.js only — a browser worker page cannot write files itself and instead reports which
 * messages it saw to the gateway's diagnostics endpoint over HTTP (see `DiagnosticsBatchSchema`
 * in `diagnostics.ts`), and the gateway appends them to that worker's own log file on its behalf.
 * That reporting deliberately travels off the connection that carries scheduling.
 */
export class MessageLogger {
	private readonly logFilePath: string;

	/**
	 * @param logFilePath Path to the JSON Lines file this logger appends to. Its parent
	 * directory is created automatically if it does not already exist.
	 */
	constructor(logFilePath: string, private readonly maximumMessagePayloadBytes = 16_384) {
		this.logFilePath = logFilePath;
		Fs.mkdirSync(Path.dirname(logFilePath), { recursive: true });
	}

	/**
	 * Appends one log entry.
	 *
	 * @param direction Whether the message was received from, or sent to, the counterpart.
	 * @param counterpart The other side of the message.
	 * @param messageType The message's `type` field.
	 * @param messagePayload The full message body.
	 * @param timestamp The moment the message was received or sent. Defaults to now; the
	 * caller normally passes the `ts` the frame itself states, and a worker-relayed entry
	 * passes the moment it actually happened in the browser.
	 * @param frame The identifying fields of the frame the message travelled in: its own
	 * identifier, the request it answers when it answers one, and the protocol version.
	 */
	log(
		direction: LogDirection,
		counterpart: LogCounterpart,
		messageType: string,
		messagePayload: unknown,
		timestamp: string = new Date().toISOString(),
		frame: { id?: string | undefined; inReplyToMessageId?: string | undefined; v?: number | undefined } = {},
	): void {
		const message = typeof messagePayload === 'object' && messagePayload !== null ? messagePayload : { type: messageType, value: messagePayload };
		const messagePayloadWithoutType = typeof messagePayload === 'object' && messagePayload !== null && Array.isArray(messagePayload) === false
			? Object.fromEntries(Object.entries(messagePayload as Record<string, unknown>).filter(([key]) => key !== 'type'))
			: messagePayload;
		const messagePayloadBytes = Buffer.byteLength(JSON.stringify(messagePayloadWithoutType), 'utf8');
		const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
		const safeMessagePayload = messagePayloadBytes > this.maximumMessagePayloadBytes
			? { type: messageType, redacted: true, messagePayloadBytes }
			: MessageLogger.redactMessagePayload(messagePayload);
		const entry: LogEntry = {
			timestamp, direction, counterpart, messageType, messagePayload: safeMessagePayload, messagePayloadBytes, messageBytes,
			...(frame.id === undefined ? {} : { messageId: frame.id }),
			...(frame.inReplyToMessageId === undefined ? {} : { inReplyToMessageId: frame.inReplyToMessageId }),
			...(frame.v === undefined ? {} : { protocolVersion: frame.v }),
		};
		Fs.appendFileSync(this.logFilePath, `${JSON.stringify(entry)}\n`, 'utf-8');
	}

	/**
	 * Removes credentials from a diagnostic record.
	 *
	 * Every property named in `redactedKeyNames` is replaced by the marker `[redacted]`,
	 * wherever it appears: at the top level of a message, inside a nested object such as the
	 * `task` of a snapshot, the `update` of a task revision, or the `messagePayload` of a
	 * message relayed by a worker, and inside an array such as the `completedStages` of a task.
	 *
	 * @param messagePayload The message body to redact.
	 * @param depth How many levels the walk has already descended. Callers leave this unset.
	 * @returns A copy of the message body with every redacted property replaced. The original
	 * is never modified.
	 */
	static redactMessagePayload(messagePayload: unknown, depth = 0): unknown {
		if (depth > maximumRedactionDepth) return redactedMarker;
		if (Array.isArray(messagePayload)) return messagePayload.map((item) => MessageLogger.redactMessagePayload(item, depth + 1));
		if (typeof messagePayload !== 'object' || messagePayload === null) return messagePayload;

		const record: Record<string, unknown> = {};
		for (const [key, original] of Object.entries(messagePayload as Record<string, unknown>)) {
			record[key] = redactedKeyNames.has(key) ? redactedMarker : MessageLogger.redactMessagePayload(original, depth + 1);
		}
		return record;
	}
}
