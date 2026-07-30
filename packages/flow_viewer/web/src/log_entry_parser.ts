import { z } from 'zod';
import type { LogEntry } from '@webai/protocol/message_logger';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The result of parsing a `.log_entry.jsonl` log file: the entries that parsed, and any lines that did not. */
export type ParseResult = {
	entries: LogEntry[];
	lineErrors: string[];
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LogEntryParser — turns raw JSON Lines text into validated LogEntry objects
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Parses the JSON Lines text written by `MessageLogger` (see `@webai/protocol/message_logger`)
 * into an array of `LogEntry` objects, tolerating malformed or unrelated lines instead of
 * failing the whole file.
 */
export class LogEntryParser {
	private static readonly logEntrySchema = z.object({
		timestamp: z.string(),
		direction: z.enum(['received', 'sent']),
		counterpart: z.object({
			role: z.string(),
			deviceId: z.string().optional(),
		}),
		messageType: z.string(),
		payload: z.unknown(),
		payloadBytes: z.number().int().nonnegative().optional(),
		messageBytes: z.number().int().nonnegative().optional(),
		// The wrapper fields. They are optional because a log recorded before the wrapper
		// existed has none of them, and such a log must still render.
		messageId: z.string().optional(),
		inReplyTo: z.string().optional(),
		protocolVersion: z.number().int().positive().optional(),
	});

	/**
	 * @param text The full contents of a `.log_entry.jsonl` log file.
	 */
	static parseJsonl(text: string): ParseResult {
		const entries: LogEntry[] = [];
		const lineErrors: string[] = [];
		const lines: string[] = text.split('\n');

		for (const [lineIndex, rawLine] of lines.entries()) {
			const line: string = rawLine.trim();
			if (line.length === 0) continue;

			const parsed: LogEntry | undefined = LogEntryParser._parseLine(line, lineIndex, lineErrors);
			if (parsed !== undefined) entries.push(parsed);
		}

		entries.sort((a: LogEntry, b: LogEntry): number => Date.parse(a.timestamp) - Date.parse(b.timestamp));
		return { entries, lineErrors };
	}

	private static _parseLine(line: string, lineIndex: number, lineErrors: string[]): LogEntry | undefined {
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			lineErrors.push(`Line ${lineIndex + 1}: not valid JSON`);
			return undefined;
		}

		const result = LogEntryParser.logEntrySchema.safeParse(json);
		if (result.success === false) {
			lineErrors.push(`Line ${lineIndex + 1}: does not match the log entry shape`);
			return undefined;
		}

		const data = result.data;
		return {
			timestamp: data.timestamp,
			direction: data.direction,
			counterpart: data.counterpart.deviceId !== undefined ? { role: data.counterpart.role, deviceId: data.counterpart.deviceId } : { role: data.counterpart.role },
			messageType: data.messageType,
			payload: data.payload,
			...(data.payloadBytes !== undefined ? { payloadBytes: data.payloadBytes } : {}),
			...(data.messageBytes !== undefined ? { messageBytes: data.messageBytes } : {}),
			...(data.messageId !== undefined ? { messageId: data.messageId } : {}),
			...(data.inReplyTo !== undefined ? { inReplyTo: data.inReplyTo } : {}),
			...(data.protocolVersion !== undefined ? { protocolVersion: data.protocolVersion } : {}),
		};
	}
}
