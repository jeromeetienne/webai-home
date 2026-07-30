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
 * The property names whose value is either the data a task carries or a credential, and is
 * therefore never written to a log file.
 *
 * `input`, `value`, and `result` are the task input, a stage input value, and the task
 * output. `text`, `inputIds`, `tensors`, and `dataBase64` are the parts of a language-model
 * stage payload. `token` is the authentication token sent in the `authenticate` message.
 */
const redactedKeyNames = new Set(['input', 'value', 'result', 'text', 'inputIds', 'tensors', 'dataBase64', 'token']);

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
	payload: unknown;
	/** The identifier of the frame this message travelled in. */
	messageId?: string;
	/** The identifier of the request this message answers, when it answers one. */
	inReplyTo?: string;
	/** The protocol version the frame stated. */
	protocolVersion?: number;
	/** Exact UTF-8 byte size of the JSON message body when the entry was recorded. */
	payloadBytes?: number;
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
 * in `index.ts`), and the gateway appends them to that worker's own log file on its behalf.
 * That reporting deliberately travels off the connection that carries scheduling.
 */
export class MessageLogger {
	private readonly logFilePath: string;

	/**
	 * @param logFilePath Path to the JSON Lines file this logger appends to. Its parent
	 * directory is created automatically if it does not already exist.
	 */
	constructor(logFilePath: string, private readonly maximumPayloadBytes = 16_384) {
		this.logFilePath = logFilePath;
		Fs.mkdirSync(Path.dirname(logFilePath), { recursive: true });
	}

	/**
	 * Appends one log entry.
	 *
	 * @param direction Whether the message was received from, or sent to, the counterpart.
	 * @param counterpart The other side of the message.
	 * @param messageType The message's `type` field.
	 * @param payload The full message body.
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
		payload: unknown,
		timestamp: string = new Date().toISOString(),
		frame: { id?: string | undefined; inReplyTo?: string | undefined; v?: number | undefined } = {},
	): void {
		const message = typeof payload === 'object' && payload !== null ? payload : { type: messageType, value: payload };
		const payloadWithoutType = typeof payload === 'object' && payload !== null && Array.isArray(payload) === false
			? Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => key !== 'type'))
			: payload;
		const payloadBytes = Buffer.byteLength(JSON.stringify(payloadWithoutType), 'utf8');
		const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
		const safePayload = payloadBytes > this.maximumPayloadBytes ? { type: messageType, redacted: true, payloadBytes } : MessageLogger.redactPayload(payload);
		const entry: LogEntry = {
			timestamp, direction, counterpart, messageType, payload: safePayload, payloadBytes, messageBytes,
			...(frame.id === undefined ? {} : { messageId: frame.id }),
			...(frame.inReplyTo === undefined ? {} : { inReplyTo: frame.inReplyTo }),
			...(frame.v === undefined ? {} : { protocolVersion: frame.v }),
		};
		Fs.appendFileSync(this.logFilePath, `${JSON.stringify(entry)}\n`, 'utf-8');
	}

	/**
	 * Removes task data and credentials from a diagnostic record.
	 *
	 * Every property named in `redactedKeyNames` is replaced by the marker `[redacted]`,
	 * wherever it appears: at the top level of a message, inside a nested object such as the
	 * `task` of a snapshot, the `update` of a task revision, or the `payload` of a message
	 * relayed by a worker, and inside an array such as the `completedStages` of a task.
	 *
	 * When the removed value is a task input — an object carrying a `taskType` discriminator —
	 * only that discriminator is kept, so a log still shows which kind of task was submitted
	 * without exposing the task's data. Every other property of the value is dropped.
	 *
	 * @param payload The message body to redact.
	 * @param depth How many levels the walk has already descended. Callers leave this unset.
	 * @returns A copy of the message body with every redacted property replaced. The original
	 * is never modified.
	 */
	static redactPayload(payload: unknown, depth = 0): unknown {
		if (depth > maximumRedactionDepth) return redactedMarker;
		if (Array.isArray(payload)) return payload.map((item) => MessageLogger.redactPayload(item, depth + 1));
		if (typeof payload !== 'object' || payload === null) return payload;

		const record: Record<string, unknown> = {};
		for (const [key, original] of Object.entries(payload as Record<string, unknown>)) {
			if (redactedKeyNames.has(key) === false) {
				record[key] = MessageLogger.redactPayload(original, depth + 1);
				continue;
			}
			const taskType: unknown = typeof original === 'object' && original !== null ? (original as Record<string, unknown>).taskType : undefined;
			record[key] = typeof taskType === 'string' ? { taskType, input: redactedMarker } : redactedMarker;
		}
		return record;
	}
}
