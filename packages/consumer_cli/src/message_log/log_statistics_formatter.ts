import type {
	CounterpartRow,
	Distribution,
	ExchangeRow,
	LogStatisticsReport,
	MessageTypeRow,
	StageGroupRow,
	TaskGroupRow,
} from './log_statistics_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The ways `log_stats` can write its report out. */
export type LogStatisticsFormat = 'text' | 'markdown' | 'json';

/** Every format `log_stats` accepts, in the order the help text lists them. */
export const logStatisticsFormats: LogStatisticsFormat[] = ['text', 'markdown', 'json'];

/** One measured value shown beside the label that names it. */
type ReportField = {
	/** What the value measures. */
	label: string;
	/** The measurement, already written out for a reader. */
	value: string;
};

/** How one column of a table is headed and lined up. */
type ReportColumn = {
	/** The column heading. */
	heading: string;
	/** Whether the column's values line up on their right edge, as numbers should. */
	alignRight: boolean;
};

/** One table of rows shown inside a section. */
type ReportTable = {
	/** A line introducing the table, when it needs one. */
	caption: string | undefined;
	/** How each column is headed and lined up. */
	columns: ReportColumn[];
	/** One array of cell values per row, in the same order as the columns. */
	rows: string[][];
};

/** One section of the report, as a title, some labelled values, and some tables. */
type ReportSection = {
	/** The section title. */
	title: string;
	/** The labelled values of the section, in the order they are shown. */
	fields: ReportField[];
	/** The tables of the section, in the order they are shown. */
	tables: ReportTable[];
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LogStatisticsFormatter — writes a measured report out as text, markdown, or JSON
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Writes a measured log report out for a reader.
 *
 * The report is turned into sections of labelled values and tables once, and each format then
 * only decides how a section, a value, and a table are drawn. Adding a format therefore cannot
 * change what any other format says, and every format states exactly the same measurements.
 */
export class LogStatisticsFormatter {
	/**
	 * Writes a report out in the requested format.
	 *
	 * @param report Every measurement taken of the log file.
	 * @param format Which format to write.
	 * @param top How many rows of each table to write before the rest are only counted.
	 * @returns The whole report as one string, ready to print.
	 */
	static format(report: LogStatisticsReport, format: LogStatisticsFormat, top: number): string {
		if (format === 'json') {
			return JSON.stringify(report, null, 2);
		}
		const sections: ReportSection[] = LogStatisticsFormatter._buildSections(report, top);
		if (format === 'markdown') {
			return LogStatisticsFormatter._renderMarkdown(sections, report, top);
		}
		return LogStatisticsFormatter._renderText(sections, top);
	}

	/**
	 * Reports whether a string names a format this class can write.
	 *
	 * @param value The value to check, as typed on the command line.
	 * @returns `true` when the value names a format.
	 */
	static isFormat(value: string): value is LogStatisticsFormat {
		return (logStatisticsFormats as string[]).includes(value);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Sections
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Turns a measured report into the sections every format draws.
	 *
	 * @param report Every measurement taken of the log file.
	 * @param top How many rows of a grouping to name before the rest are only counted.
	 * @returns One section per part of the report, in the order they are shown.
	 */
	private static _buildSections(report: LogStatisticsReport, top: number): ReportSection[] {
		return [
			LogStatisticsFormatter._fileSection(report),
			LogStatisticsFormatter._timeSpanSection(report),
			LogStatisticsFormatter._trafficSection(report),
			LogStatisticsFormatter._messageTypeSection(report),
			LogStatisticsFormatter._counterpartSection(report),
			LogStatisticsFormatter._replySection(report),
			LogStatisticsFormatter._taskSection(report, top),
			LogStatisticsFormatter._stageRunSection(report),
			LogStatisticsFormatter._concernSection(report),
		];
	}

	/**
	 * Builds the section describing the file itself.
	 *
	 * @param report Every measurement taken of the log file.
	 * @returns The file section.
	 */
	private static _fileSection(report: LogStatisticsReport): ReportSection {
		const file = report.file;
		const versions: string = file.protocolVersions.length === 0 ? 'none recorded' : file.protocolVersions.join(', ');
		return {
			title: 'File',
			fields: [
				{
					label: 'path',
					value: file.filePath,
				},
				{
					label: 'size on disk',
					value: LogStatisticsFormatter.formatBytes(file.fileBytes),
				},
				{
					label: 'lines',
					value: `${file.lineCount} read, ${file.entryCount} readable as a log entry, ${file.unreadableLineCount} not`,
				},
				{
					label: 'protocol versions',
					value: versions,
				},
			],
			tables: [],
		};
	}

	/**
	 * Builds the section describing when the traffic happened.
	 *
	 * @param report Every measurement taken of the log file.
	 * @returns The time span section.
	 */
	private static _timeSpanSection(report: LogStatisticsReport): ReportSection {
		const timeSpan = report.timeSpan;
		const busiest: string = timeSpan.busiestSecondTimestamp === undefined
			? `${timeSpan.busiestSecondMessageCount} in the busiest second`
			: `${timeSpan.busiestSecondMessageCount} in the busiest second, starting ${timeSpan.busiestSecondTimestamp}`;
		const silence: string = timeSpan.longestSilenceStartsAt === undefined
			? LogStatisticsFormatter.formatDuration(timeSpan.longestSilenceMs)
			: `${LogStatisticsFormatter.formatDuration(timeSpan.longestSilenceMs)}, starting ${timeSpan.longestSilenceStartsAt}`;
		return {
			title: 'Time span',
			fields: [
				{
					label: 'first message',
					value: timeSpan.firstTimestamp ?? '—',
				},
				{
					label: 'last message',
					value: timeSpan.lastTimestamp ?? '—',
				},
				{
					label: 'duration',
					value: LogStatisticsFormatter.formatDuration(timeSpan.durationMs),
				},
				{
					label: 'message rate',
					value: `${timeSpan.messagesPerSecond.toFixed(2)} per second on average, ${busiest}`,
				},
				{
					label: 'gap between messages',
					value: LogStatisticsFormatter._durationDistribution(timeSpan.gapMs),
				},
				{
					label: 'longest silence',
					value: silence,
				},
			],
			tables: [],
		};
	}

	/**
	 * Builds the section describing how much was carried.
	 *
	 * @param report Every measurement taken of the log file.
	 * @returns The traffic section.
	 */
	private static _trafficSection(report: LogStatisticsReport): ReportSection {
		const traffic = report.traffic;
		const largest: string = traffic.largestMessage === undefined
			? '—'
			: `${traffic.largestMessage.messageType}, ${LogStatisticsFormatter.formatBytes(traffic.largestMessage.messageBytes)}, at ${traffic.largestMessage.timestamp}`;
		return {
			title: 'Traffic',
			fields: [
				{
					label: 'messages',
					value: `${traffic.messageCount} (${traffic.sentCount} sent, ${traffic.receivedCount} received)`,
				},
				{
					label: 'on the wire',
					value: `${LogStatisticsFormatter.formatBytes(traffic.messageBytes.total)} (${LogStatisticsFormatter.formatBytes(traffic.sentBytes)} sent, ${LogStatisticsFormatter.formatBytes(traffic.receivedBytes)} received)`,
				},
				{
					label: 'message bodies',
					value: LogStatisticsFormatter.formatBytes(traffic.messagePayloadBytes.total),
				},
				{
					label: 'envelope overhead',
					value: `${LogStatisticsFormatter.formatBytes(traffic.envelopeOverheadBytes)} (${traffic.envelopeOverheadPercent.toFixed(1)}% of the wire bytes)`,
				},
				{
					label: 'repeated bodies',
					value: `${traffic.repeatedBodyCount} message${traffic.repeatedBodyCount === 1 ? '' : 's'} carried a body already sent once, costing ${LogStatisticsFormatter.formatBytes(traffic.repeatedBodyBytes)}`,
				},
				{
					label: 'message size',
					value: LogStatisticsFormatter._bytesDistribution(traffic.messageBytes),
				},
				{
					label: 'largest message',
					value: largest,
				},
			],
			tables: [],
		};
	}

	/**
	 * Builds the section counting and sizing every message type.
	 *
	 * @param report Every measurement taken of the log file.
	 * @returns The message type section.
	 */
	private static _messageTypeSection(report: LogStatisticsReport): ReportSection {
		return {
			title: `Message types (${report.byMessageType.length})`,
			fields: [],
			tables: [
				{
					caption: undefined,
					columns: LogStatisticsFormatter._columns(
						['message type', false],
						['count', true],
						['share', true],
						['sent', true],
						['received', true],
						['bytes', true],
						['bytes share', true],
						['mean size', true],
					),
					rows: report.byMessageType.map((row: MessageTypeRow): string[] => [
						row.messageType,
						String(row.count),
						`${row.countPercent.toFixed(1)}%`,
						String(row.sentCount),
						String(row.receivedCount),
						LogStatisticsFormatter.formatBytes(row.messageBytes),
						`${row.bytesPercent.toFixed(1)}%`,
						LogStatisticsFormatter.formatBytes(row.meanMessageBytes),
					]),
				},
			],
		};
	}

	/**
	 * Builds the section counting and sizing the traffic with each counterpart.
	 *
	 * @param report Every measurement taken of the log file.
	 * @returns The counterpart section.
	 */
	private static _counterpartSection(report: LogStatisticsReport): ReportSection {
		return {
			title: `Counterparts (${report.byCounterpart.length})`,
			fields: [],
			tables: [
				{
					caption: undefined,
					columns: LogStatisticsFormatter._columns(
						['role', false],
						['device', false],
						['messages', true],
						['bytes', true],
						['first seen', false],
						['last seen', false],
					),
					rows: report.byCounterpart.map((row: CounterpartRow): string[] => [
						row.role,
						row.deviceId,
						String(row.count),
						LogStatisticsFormatter.formatBytes(row.messageBytes),
						row.firstSeenAt,
						row.lastSeenAt,
					]),
				},
			],
		};
	}

	/**
	 * Builds the section timing how long replies took.
	 *
	 * @param report Every measurement taken of the log file.
	 * @returns The request and reply section.
	 */
	private static _replySection(report: LogStatisticsReport): ReportSection {
		const reply = report.reply;
		const slowest: string = reply.slowestExchange === undefined
			? '—'
			: `${reply.slowestExchange.exchange}, ${LogStatisticsFormatter.formatDuration(reply.slowestExchange.latencyMs)}, at ${reply.slowestExchange.timestamp}`;
		return {
			title: 'Request and reply',
			fields: [
				{
					label: 'matched',
					value: reply.matchedCount === 1
						? '1 reply was matched to the request it answers'
						: `${reply.matchedCount} replies were matched to the requests they answer`,
				},
				{
					label: 'unmatched',
					value: reply.unmatchedReplyCount === 1
						? '1 reply named a request this file does not contain'
						: `${reply.unmatchedReplyCount} replies named a request this file does not contain`,
				},
				{
					label: 'reply delay',
					value: LogStatisticsFormatter._durationDistribution(reply.latencyMs),
				},
				{
					label: 'slowest',
					value: slowest,
				},
			],
			tables: reply.byExchange.length === 0 ? [] : [
				{
					caption: undefined,
					columns: LogStatisticsFormatter._columns(
						['exchange', false],
						['count', true],
						['median', true],
						['90th', true],
						['99th', true],
						['max', true],
					),
					rows: reply.byExchange.map((row: ExchangeRow): string[] => [
						row.exchange,
						String(row.count),
						LogStatisticsFormatter.formatDuration(row.latencyMs.median),
						LogStatisticsFormatter.formatDuration(row.latencyMs.percentile90),
						LogStatisticsFormatter.formatDuration(row.latencyMs.percentile99),
						LogStatisticsFormatter.formatDuration(row.latencyMs.maximum),
					]),
				},
			],
		};
	}

	/**
	 * Builds the section describing what became of the tasks.
	 *
	 * @param report Every measurement taken of the log file.
	 * @param top How many groups to name before the rest are only counted.
	 * @returns The task section.
	 */
	private static _taskSection(report: LogStatisticsReport, top: number): ReportSection {
		const tasks = report.tasks;
		return {
			title: 'Tasks',
			fields: [
				{
					label: 'tasks seen',
					value: `${tasks.taskCount} (${tasks.completedCount} completed, ${tasks.failedCount} failed, ${tasks.cancelledCount} cancelled, ${tasks.unfinishedCount} never seen finishing)`,
				},
				{
					label: 'retried',
					value: `${tasks.retriedCount} task${tasks.retriedCount === 1 ? '' : 's'} had a stage retried, highest attempt number ${tasks.maximumAttempt}`,
				},
				{
					label: 'admission',
					value: `${LogStatisticsFormatter._durationDistribution(tasks.admissionMs)} — submitted until accepted`,
				},
				{
					label: 'queue wait',
					value: `${LogStatisticsFormatter._durationDistribution(tasks.queueWaitMs)} — accepted until the first stage was assigned`,
				},
				{
					label: 'end to end',
					value: `${LogStatisticsFormatter._durationDistribution(tasks.endToEndMs)} — submitted until finished`,
				},
				{
					label: 'stage runs per task',
					value: LogStatisticsFormatter._countDistribution(tasks.stageRunsPerTask),
				},
				{
					label: 'messages per task',
					value: LogStatisticsFormatter._countDistribution(tasks.messagesPerTask),
				},
				{
					label: 'bytes per task',
					value: LogStatisticsFormatter._bytesDistribution(tasks.bytesPerTask),
				},
				...LogStatisticsFormatter._groupField('by final state', tasks.byFinalState, top),
				...LogStatisticsFormatter._groupField('by task type', tasks.byTaskType, top),
				...LogStatisticsFormatter._groupField('by worker', tasks.byWorker, top),
			],
			tables: [],
		};
	}

	/**
	 * Builds the section describing each individual run of a stage on a worker.
	 *
	 * @param report Every measurement taken of the log file.
	 * @returns The stage run section.
	 */
	private static _stageRunSection(report: LogStatisticsReport): ReportSection {
		const stageRuns = report.stageRuns;
		const toRow = (row: StageGroupRow): string[] => [
			row.key,
			String(row.count),
			LogStatisticsFormatter.formatDuration(row.computeMs.median),
			LogStatisticsFormatter.formatDuration(row.computeMs.percentile90),
			LogStatisticsFormatter.formatDuration(row.computeMs.percentile99),
			LogStatisticsFormatter.formatDuration(row.computeMs.maximum),
		];
		const rows: string[][] = [
			...stageRuns.byStageName.map(toRow),
			...stageRuns.byWorker.map(toRow),
		];
		return {
			title: 'Stage runs',
			fields: [
				{
					label: 'stage runs seen',
					value: `${stageRuns.stageRunCount} (${stageRuns.unfinishedCount} never seen producing a result)`,
				},
				{
					label: 'worker pickup',
					value: `${LogStatisticsFormatter._durationDistribution(stageRuns.pickupMs)} — assigned until the worker confirmed`,
				},
				{
					label: 'compute',
					value: `${LogStatisticsFormatter._durationDistribution(stageRuns.computeMs)} — worker confirmed until it sent the result`,
				},
				{
					label: 'result recorded',
					value: `${LogStatisticsFormatter._durationDistribution(stageRuns.commitMs)} — result sent until the gateway recorded it`,
				},
			],
			tables: rows.length === 0 ? [] : [
				{
					caption: 'Compute time by stage, then by worker',
					columns: LogStatisticsFormatter._columns(
						['stage runs grouped by', false],
						['runs', true],
						['median', true],
						['90th', true],
						['99th', true],
						['max', true],
					),
					rows,
				},
			],
		};
	}

	/**
	 * Builds the section collecting everything worth a second look.
	 *
	 * @param report Every measurement taken of the log file.
	 * @returns The concerns section.
	 */
	private static _concernSection(report: LogStatisticsReport): ReportSection {
		const concerns = report.concerns;
		const errorTypes: string = concerns.errorMessageTypes.length === 0
			? 'none'
			: concerns.errorMessageTypes.map((row: TaskGroupRow): string => `${row.key} ${row.count}`).join(', ');
		return {
			title: 'Worth a second look',
			fields: [
				{
					label: 'unreadable lines',
					value: concerns.unreadableLineCount === 0
						? '0'
						: `${concerns.unreadableLineCount} (${concerns.unreadableLineSamples.join('; ')})`,
				},
				{
					label: 'out of time order',
					value: `${concerns.outOfOrderCount} message${concerns.outOfOrderCount === 1 ? ' was' : 's were'} written after a message with a later timestamp`,
				},
				{
					label: 'failure messages',
					value: `${concerns.errorMessageCount} (${errorTypes})`,
				},
				{
					label: 'oversize bodies',
					value: `${concerns.oversizeBodyCount} message bod${concerns.oversizeBodyCount === 1 ? 'y was' : 'ies were'} too large to record and were replaced by a marker`,
				},
				{
					label: 'unnamed devices',
					value: `${concerns.unidentifiedCounterpartCount} message${concerns.unidentifiedCounterpartCount === 1 ? '' : 's'} named no device, because the counterpart had not registered yet`,
				},
			],
			tables: [],
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Rendering
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Draws the sections as the plain text printed to a terminal, with each label and each
	 * table column lined up.
	 *
	 * @param sections Every section of the report.
	 * @param top How many rows of each table to draw before the rest are only counted.
	 * @returns The whole report as one string.
	 */
	private static _renderText(sections: ReportSection[], top: number): string {
		const blocks: string[] = [];
		for (const section of sections) {
			const lines: string[] = [section.title, '─'.repeat(section.title.length)];
			const labelWidth: number = Math.max(0, ...section.fields.map((field: ReportField): number => field.label.length));
			for (const field of section.fields) {
				lines.push(`  ${field.label.padEnd(labelWidth + 2)}${field.value}`);
			}
			for (const table of section.tables) {
				lines.push('');
				if (table.caption !== undefined) {
					lines.push(`  ${table.caption}`);
				}
				lines.push(...LogStatisticsFormatter._textTable(table, top));
			}
			blocks.push(lines.join('\n'));
		}
		return blocks.join('\n\n');
	}

	/**
	 * Draws one table as plain text, with each column padded to its widest value.
	 *
	 * @param table The table to draw.
	 * @param top How many rows to draw before the rest are only counted.
	 * @returns The table's lines, headings first.
	 */
	private static _textTable(table: ReportTable, top: number): string[] {
		if (table.rows.length === 0) {
			return ['  (nothing to show)'];
		}
		const shown: string[][] = table.rows.slice(0, top);
		const headings: string[] = table.columns.map((column: ReportColumn): string => column.heading.toUpperCase());
		const widths: number[] = table.columns.map((column: ReportColumn, index: number): number => Math.max(
			column.heading.length,
			...shown.map((row: string[]): number => (row[index] ?? '').length),
		));
		const layOut = (cells: string[]): string => `  ${cells
			.map((cell: string, index: number): string => {
				const width: number = widths[index] ?? 0;
				return table.columns[index]?.alignRight === true ? cell.padStart(width) : cell.padEnd(width);
			})
			.join('  ')
			.trimEnd()}`;

		const lines: string[] = [layOut(headings), ...shown.map(layOut)];
		const remaining: number = table.rows.length - shown.length;
		if (remaining > 0) {
			lines.push(`  … and ${remaining} more row${remaining === 1 ? '' : 's'}`);
		}
		return lines;
	}

	/**
	 * Draws the sections as markdown, so a report can be pasted straight into an issue, a pull
	 * request, or a notes file and still read as a report.
	 *
	 * @param sections Every section of the report.
	 * @param report The measured report, read for the title line.
	 * @param top How many rows of each table to draw before the rest are only counted.
	 * @returns The whole report as one markdown document.
	 */
	private static _renderMarkdown(sections: ReportSection[], report: LogStatisticsReport, top: number): string {
		const blocks: string[] = [`# Message log statistics for \`${report.file.filePath}\``];
		for (const section of sections) {
			blocks.push(`## ${section.title}`);
			if (section.fields.length > 0) {
				const rows: string[][] = section.fields.map((field: ReportField): string[] => [field.label, field.value]);
				blocks.push(LogStatisticsFormatter._markdownTable(
					LogStatisticsFormatter._columns(['measure', false], ['value', false]),
					rows,
					rows.length,
				));
			}
			for (const table of section.tables) {
				if (table.caption !== undefined) {
					blocks.push(`**${table.caption}**`);
				}
				blocks.push(LogStatisticsFormatter._markdownTable(table.columns, table.rows, top));
			}
		}
		return `${blocks.join('\n\n')}\n`;
	}

	/**
	 * Draws one table as a markdown pipe table, right-aligning the columns that hold numbers.
	 *
	 * @param columns How each column is headed and lined up.
	 * @param rows One array of cell values per row.
	 * @param top How many rows to draw before the rest are only counted.
	 * @returns The table as one markdown block.
	 */
	private static _markdownTable(columns: ReportColumn[], rows: string[][], top: number): string {
		if (rows.length === 0) {
			return '_(nothing to show)_';
		}
		const shown: string[][] = rows.slice(0, top);
		const escape = (cell: string): string => cell.replaceAll('|', '\\|');
		const lines: string[] = [
			`| ${columns.map((column: ReportColumn): string => escape(column.heading)).join(' | ')} |`,
			`| ${columns.map((column: ReportColumn): string => (column.alignRight === true ? '---:' : '---')).join(' | ')} |`,
			...shown.map((row: string[]): string => `| ${columns.map((_column: ReportColumn, index: number): string => escape(row[index] ?? '')).join(' | ')} |`),
		];
		const remaining: number = rows.length - shown.length;
		if (remaining > 0) {
			lines.push(`| … and ${remaining} more row${remaining === 1 ? '' : 's'} |${' |'.repeat(Math.max(0, columns.length - 1))}`);
		}
		return lines.join('\n');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Writing Values Out
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Writes a byte count the way it reads shortest.
	 *
	 * @param bytes The number of bytes.
	 * @returns The count in bytes, kibibytes, or mebibytes.
	 */
	static formatBytes(bytes: number): string {
		if (bytes < 1024) {
			return `${Math.round(bytes)} B`;
		}
		if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)} KiB`;
		}
		return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
	}

	/**
	 * Writes a duration the way it reads shortest.
	 *
	 * @param milliseconds The duration in milliseconds.
	 * @returns The duration in milliseconds, seconds, minutes, or hours.
	 */
	static formatDuration(milliseconds: number): string {
		if (milliseconds < 1000) {
			return `${Math.round(milliseconds)} ms`;
		}
		if (milliseconds < 60 * 1000) {
			return `${(milliseconds / 1000).toFixed(2)} s`;
		}
		if (milliseconds < 60 * 60 * 1000) {
			return `${(milliseconds / (60 * 1000)).toFixed(1)} min`;
		}
		return `${(milliseconds / (60 * 60 * 1000)).toFixed(1)} h`;
	}

	/**
	 * Builds the column descriptions of a table from a heading and an alignment each.
	 *
	 * @param entries One heading and whether that column lines up on its right edge.
	 * @returns The column descriptions, in the order given.
	 */
	private static _columns(...entries: [string, boolean][]): ReportColumn[] {
		return entries.map(([heading, alignRight]: [string, boolean]): ReportColumn => ({
			heading,
			alignRight,
		}));
	}

	/**
	 * Writes one grouping as a single labelled value naming the largest groups.
	 *
	 * @param label What the groups are grouped by.
	 * @param rows The groups, most frequent first.
	 * @param top How many groups to name before the rest are only counted.
	 * @returns The labelled value, or nothing at all when there is nothing to group.
	 */
	private static _groupField(label: string, rows: TaskGroupRow[], top: number): ReportField[] {
		if (rows.length === 0) {
			return [];
		}
		const shown: TaskGroupRow[] = rows.slice(0, top);
		const named: string = shown.map((row: TaskGroupRow): string => `${row.key} ${row.count}`).join(', ');
		const remaining: number = rows.length - shown.length;
		return [
			{
				label,
				value: remaining === 0 ? named : `${named}, and ${remaining} more`,
			},
		];
	}

	/**
	 * Writes a spread of durations as one line.
	 *
	 * @param distribution The measured durations, in milliseconds.
	 * @returns The line, or a note that nothing was measured.
	 */
	private static _durationDistribution(distribution: Distribution): string {
		if (distribution.count === 0) {
			return '— nothing measured';
		}
		return `median ${LogStatisticsFormatter.formatDuration(distribution.median)}`
			+ ` · 90th ${LogStatisticsFormatter.formatDuration(distribution.percentile90)}`
			+ ` · 99th ${LogStatisticsFormatter.formatDuration(distribution.percentile99)}`
			+ ` · min ${LogStatisticsFormatter.formatDuration(distribution.minimum)}`
			+ ` · max ${LogStatisticsFormatter.formatDuration(distribution.maximum)}`
			+ ` · mean ${LogStatisticsFormatter.formatDuration(distribution.mean)}`
			+ ` · from ${distribution.count}`;
	}

	/**
	 * Writes a spread of byte counts as one line.
	 *
	 * @param distribution The measured byte counts.
	 * @returns The line, or a note that nothing was measured.
	 */
	private static _bytesDistribution(distribution: Distribution): string {
		if (distribution.count === 0) {
			return '— nothing measured';
		}
		return `median ${LogStatisticsFormatter.formatBytes(distribution.median)}`
			+ ` · 90th ${LogStatisticsFormatter.formatBytes(distribution.percentile90)}`
			+ ` · 99th ${LogStatisticsFormatter.formatBytes(distribution.percentile99)}`
			+ ` · min ${LogStatisticsFormatter.formatBytes(distribution.minimum)}`
			+ ` · max ${LogStatisticsFormatter.formatBytes(distribution.maximum)}`
			+ ` · mean ${LogStatisticsFormatter.formatBytes(distribution.mean)}`;
	}

	/**
	 * Writes a spread of plain counts as one line.
	 *
	 * @param distribution The measured counts.
	 * @returns The line, or a note that nothing was measured.
	 */
	private static _countDistribution(distribution: Distribution): string {
		if (distribution.count === 0) {
			return '— nothing measured';
		}
		return `median ${distribution.median}`
			+ ` · 90th ${distribution.percentile90}`
			+ ` · min ${distribution.minimum}`
			+ ` · max ${distribution.maximum}`
			+ ` · mean ${distribution.mean.toFixed(1)}`
			+ ` · total ${distribution.total}`;
	}
}
