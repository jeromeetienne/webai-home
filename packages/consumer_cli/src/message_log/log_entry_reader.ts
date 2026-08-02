import Fs from 'node:fs';
import { z } from 'zod';
import type { LogEntry } from '@webai/protocol/message_logger';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LogEntryReader — reads a .log_entry.jsonl file into validated LogEntry objects
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One line of a log file that could not be turned into a log entry, and why. */
export type LogLineError = {
	/** The line's position in the file, counting the first line as 1. */
	lineNumber: number;
	/** Why the line was skipped, in plain words. */
	reason: string;
};

/** Everything reading one `.log_entry.jsonl` file produced. */
export type LogFileContents = {
	/** The path the file was read from. */
	filePath: string;
	/** The size of the file on disk, in bytes. */
	fileBytes: number;
	/** How many non-empty lines the file held. */
	lineCount: number;
	/** Every entry that parsed, oldest first. */
	entries: LogEntry[];
	/** Every line that did not parse. */
	lineErrors: LogLineError[];
	/**
	 * How many entries were written to the file after an entry with a later timestamp.
	 *
	 * This is counted in the order the lines appear on disk, before they are sorted, because
	 * sorting is exactly what hides it. A log an actor appends to as messages happen should
	 * never contain one, so any at all mean the recorded moments cannot be taken at face value.
	 */
	outOfOrderCount: number;
};

/**
 * Reads the JSON Lines files written by `MessageLogger` (see `@webai/protocol/message_logger`).
 *
 * A line that is not valid JSON, or that does not carry the fields a log entry must have, is
 * collected as a `LogLineError` rather than failing the whole file: a log that was still being
 * appended to when it was copied ends in a half-written line, and the rest of it is still worth
 * measuring.
 */
export class LogEntryReader {
	/**
	 * The shape a line must have to count as a log entry.
	 *
	 * The wrapper fields are optional because a log recorded before the message wrapper existed
	 * has none of them, and such a log must still be readable.
	 */
	private static readonly _logEntrySchema = z.object({
		timestamp: z.string(),
		direction: z.enum(['received', 'sent']),
		counterpart: z.object({
			role: z.string(),
			deviceId: z.string().optional(),
		}),
		messageType: z.string(),
		messagePayload: z.unknown(),
		messagePayloadBytes: z.number().int().nonnegative().optional(),
		messageBytes: z.number().int().nonnegative().optional(),
		messageId: z.string().optional(),
		inReplyToMessageId: z.string().optional(),
		protocolVersion: z.number().int().positive().optional(),
	});

	/**
	 * Reads one log file from disk and parses every line in it.
	 *
	 * @param filePath The path of the `.log_entry.jsonl` file to read.
	 * @returns The entries that parsed, sorted oldest first, alongside the lines that did not.
	 * @throws {Error} If the file cannot be read.
	 */
	static readFile(filePath: string): LogFileContents {
		const text: string = Fs.readFileSync(filePath, 'utf-8');
		const fileBytes: number = Fs.statSync(filePath).size;
		const parsed = LogEntryReader.parseJsonl(text);
		return {
			filePath,
			fileBytes,
			lineCount: parsed.lineCount,
			entries: parsed.entries,
			lineErrors: parsed.lineErrors,
			outOfOrderCount: parsed.outOfOrderCount,
		};
	}

	/**
	 * Parses the text of a log file, without touching the filesystem.
	 *
	 * @param text The full contents of a `.log_entry.jsonl` file.
	 * @returns The non-empty line count, the entries that parsed sorted oldest first, the lines
	 * that did not parse, and how many entries were written out of time order.
	 */
	static parseJsonl(text: string): Omit<LogFileContents, 'filePath' | 'fileBytes'> {
		const entries: LogEntry[] = [];
		const lineErrors: LogLineError[] = [];
		let lineCount = 0;
		let outOfOrderCount = 0;
		let previousTimestampMs: number | undefined;

		for (const [lineIndex, rawLine] of text.split('\n').entries()) {
			const line: string = rawLine.trim();
			if (line.length === 0) {
				continue;
			}
			lineCount += 1;
			const entry: LogEntry | undefined = LogEntryReader._parseLine(line, lineIndex + 1, lineErrors);
			if (entry === undefined) {
				continue;
			}
			entries.push(entry);

			const timestampMs: number = Date.parse(entry.timestamp);
			if (Number.isNaN(timestampMs) === false) {
				if (previousTimestampMs !== undefined && timestampMs < previousTimestampMs) {
					outOfOrderCount += 1;
				}
				previousTimestampMs = timestampMs;
			}
		}

		entries.sort((left: LogEntry, right: LogEntry): number => Date.parse(left.timestamp) - Date.parse(right.timestamp));
		return {
			lineCount,
			entries,
			lineErrors,
			outOfOrderCount,
		};
	}

	/**
	 * Parses one line, recording why it was skipped when it cannot be parsed.
	 *
	 * @param line The trimmed text of the line.
	 * @param lineNumber The line's position in the file, counting the first line as 1.
	 * @param lineErrors The list this function appends to when the line cannot be parsed.
	 * @returns The parsed entry, or `undefined` when the line was skipped.
	 */
	private static _parseLine(line: string, lineNumber: number, lineErrors: LogLineError[]): LogEntry | undefined {
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			lineErrors.push({
				lineNumber,
				reason: 'not valid JSON',
			});
			return undefined;
		}

		const result = LogEntryReader._logEntrySchema.safeParse(json);
		if (result.success === false) {
			lineErrors.push({
				lineNumber,
				reason: 'does not have the fields a log entry must have',
			});
			return undefined;
		}

		const data = result.data;
		return {
			timestamp: data.timestamp,
			direction: data.direction,
			counterpart: data.counterpart.deviceId !== undefined
				? {
					role: data.counterpart.role,
					deviceId: data.counterpart.deviceId,
				}
				: {
					role: data.counterpart.role,
				},
			messageType: data.messageType,
			messagePayload: data.messagePayload,
			...(data.messagePayloadBytes === undefined ? {} : { messagePayloadBytes: data.messagePayloadBytes }),
			...(data.messageBytes === undefined ? {} : { messageBytes: data.messageBytes }),
			...(data.messageId === undefined ? {} : { messageId: data.messageId }),
			...(data.inReplyToMessageId === undefined ? {} : { inReplyToMessageId: data.inReplyToMessageId }),
			...(data.protocolVersion === undefined ? {} : { protocolVersion: data.protocolVersion }),
		};
	}
}
