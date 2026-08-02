import Fs from 'node:fs';
import { LogEntryReader, type LogFileContents } from '../message_log/log_entry_reader.js';
import { LogStatistics } from '../message_log/log_statistics.js';
import { LogStatisticsFormatter, type LogStatisticsFormat } from '../message_log/log_statistics_formatter.js';
import { CliError } from '../libs/cli_errors.js';
import type { LogStatisticsReport } from '../message_log/log_statistics_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LogStatsCommand — prints everything measurable about one .log_entry.jsonl file
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `consumer_cli log_stats <file>` needs to know to measure a log file and print it. */
export type LogStatsCommandOptions = {
	/** The path of the `.log_entry.jsonl` file to measure. */
	filePath: string;
	/** Which format to print the report in. */
	format: LogStatisticsFormat;
	/** How many rows of each table to print before the rest are summarised as one line. */
	top: number;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Log Stats Command
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Reads one message log file and prints what it measures: how much traffic it carried, who
 * carried it, how long every answer took, what became of every task and every stage run, and
 * anything about the file worth a second look.
 *
 * This command never connects to the central gateway. It answers questions about a capture
 * that has already happened, so a log written weeks ago measures exactly the same way as one
 * written a moment ago. `LogStatistics` does the measuring, and `LogStatisticsFormatter` does
 * the printing, so this command is only the file handling and the error reporting between them.
 */
export class LogStatsCommand {
	/**
	 * Measures one log file and prints the report.
	 *
	 * @param options Which file to measure, in which format, and how much of it to print.
	 * @throws {CliError} If the file cannot be read, or holds no readable log entry.
	 */
	static async run(options: LogStatsCommandOptions): Promise<void> {
		if (Fs.existsSync(options.filePath) === false) {
			throw new CliError(`No such log file: ${options.filePath}`, 1);
		}

		let contents: LogFileContents;
		try {
			contents = LogEntryReader.readFile(options.filePath);
		} catch (error) {
			const message: string = error instanceof Error ? error.message : String(error);
			throw new CliError(`Could not read ${options.filePath}: ${message}`, 1);
		}

		if (contents.entries.length === 0) {
			throw new CliError(`${options.filePath} holds no readable log entry (${contents.lineCount} line${contents.lineCount === 1 ? '' : 's'} read)`, 1);
		}

		const report: LogStatisticsReport = LogStatistics.calculate(contents);
		console.log(LogStatisticsFormatter.format(report, options.format, options.top));
	}
}
