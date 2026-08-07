// local imports
import {
	benchmarkReportFormats,
	type BenchmarkReport,
	type BenchmarkReportFormat,
	type BenchmarkSummary,
	type SweepOutcome,
} from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportRenderer — turns outcomes and measurements into the lines a person reads
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Writes out what `text_completion`, `conversation_history`, and `benchmark` produced. */
export class ReportRenderer {
	/**
	 * Builds the analysis line for one swept model and mode pair. The raw answer, or the two
	 * turns of a conversation, have already been written out as they were produced, so this line
	 * reads as commentary on text already shown rather than repeating it.
	 *
	 * @param outcome The outcome to describe.
	 * @returns The one line to print.
	 */
	static sweepOutcomeLine(outcome: SweepOutcome): string {
		if (outcome.status === 'skipped') {
			return `${outcome.modelId} (${outcome.mode}): skipped — ${String(outcome.failureMessage)}`;
		}
		const timings = [
			`first character in ${Math.round(outcome.timeToFirstCharacterMs)} ms`,
			`last character in ${Math.round(outcome.timeToLastCharacterMs)} ms`,
			`${outcome.characterCount} characters`,
		].join(', ');
		const line = `${outcome.modelId} (${outcome.mode}): ${outcome.status} — ${timings}`;
		if (outcome.status === 'failed') {
			return `${line} — ${String(outcome.failureMessage)}`;
		}
		return line;
	}

	/**
	 * Prints the analysis line for one swept model and mode pair, sending a failure to the error
	 * output so that a run piped into a file still shows what went wrong.
	 *
	 * @param outcome The outcome to print.
	 * @returns Nothing.
	 */
	static printSweepOutcome(outcome: SweepOutcome): void {
		const line = ReportRenderer.sweepOutcomeLine(outcome);
		if (outcome.status === 'failed') {
			console.error(line);
			return;
		}
		console.log(line);
	}

	/**
	 * Builds the summary table printed at the end of a sweep.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns The lines to print, in order.
	 */
	static sweepSummaryLines(outcomes: readonly SweepOutcome[]): string[] {
		const lines: string[] = ['', 'Summary:'];
		for (const outcome of outcomes) {
			lines.push(`  ${outcome.modelId} (${outcome.mode}): ${outcome.status}`);
		}
		const failureCount = outcomes.filter((outcome) => outcome.status === 'failed').length;
		const skippedCount = outcomes.filter((outcome) => outcome.status === 'skipped').length;
		const passedCount = outcomes.length - failureCount - skippedCount;
		lines.push('');
		lines.push(`${passedCount}/${outcomes.length} passed, ${skippedCount} skipped, ${failureCount} failed`);
		return lines;
	}

	/**
	 * Prints the summary table at the end of a sweep.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns Nothing.
	 */
	static printSweepSummary(outcomes: readonly SweepOutcome[]): void {
		for (const line of ReportRenderer.sweepSummaryLines(outcomes)) {
			console.log(line);
		}
	}

	/**
	 * Writes a benchmark report out in the requested format.
	 *
	 * @param report The full benchmark report to write.
	 * @param format Which format to write.
	 * @returns The whole report as one string, ready to print.
	 */
	static formatBenchmarkReport(report: BenchmarkReport, format: BenchmarkReportFormat): string {
		if (format === 'json') {
			return JSON.stringify(report, null, 2);
		}
		if (format === 'markdown') {
			return ReportRenderer._renderMarkdownReport(report);
		}
		return ReportRenderer._renderTextReport(report);
	}

	/**
	 * Reports whether a string names a format `formatBenchmarkReport` can write.
	 *
	 * @param value The value to check, as typed on the command line.
	 * @returns `true` when the value names a format.
	 */
	static isReportFormat(value: string): value is BenchmarkReportFormat {
		return (benchmarkReportFormats as readonly string[]).includes(value);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Rounds a report number for readable human output, while the JSON format keeps full values.
	 *
	 * @param value The report number to round.
	 * @returns The number as text with two decimal places.
	 */
	private static _rounded(value: number): string {
		return value.toFixed(2);
	}

	/**
	 * Renders the benchmark report as the compact human-readable text printed to a terminal, one
	 * block per measured model.
	 *
	 * @param report The full benchmark report to render.
	 * @returns The whole report as one string.
	 */
	private static _renderTextReport(report: BenchmarkReport): string {
		const lines: string[] = [
			`OpenAI API benchmark (parallelism: ${report.settings.parallelism})`,
			`Measured requests: ${report.settings.runs}; warm-up requests: ${report.settings.warmupRuns}`,
		];
		for (const summary of report.summaries) {
			lines.push('');
			lines.push(`${summary.baseUrl} (${summary.modelId})`);
			lines.push(`  Time to First Character:      ${ReportRenderer._statisticsLine(summary.timeToFirstCharacterMs)}`);
			lines.push(`  Time to Last Character:       ${ReportRenderer._statisticsLine(summary.timeToLastCharacterMs)}`);
			lines.push(`  Output Characters per Second: ${ReportRenderer._rounded(summary.outputCharactersPerSecond.average)} characters/second average`);
			lines.push(`  Input Characters:             ${summary.inputCharacters} characters`);
			lines.push(`  Output Characters:            ${ReportRenderer._rounded(summary.outputCharacters.average)} characters average`);
		}
		return lines.join('\n');
	}

	/**
	 * Renders one metric's average, median, and range as the single line the text report shows.
	 *
	 * @param statistics The statistics of one metric, in milliseconds.
	 * @returns The one line describing the metric.
	 */
	private static _statisticsLine(statistics: BenchmarkSummary['timeToFirstCharacterMs']): string {
		const average = ReportRenderer._rounded(statistics.average);
		const median = ReportRenderer._rounded(statistics.median);
		const minimum = ReportRenderer._rounded(statistics.minimum);
		const maximum = ReportRenderer._rounded(statistics.maximum);
		return `${average} ms average, ${median} ms median, ${minimum}–${maximum} ms range`;
	}

	/**
	 * Renders the benchmark report as markdown, so it can be pasted straight into an issue, a
	 * pull request, or a notes file and still read as a report. Every measured model is one row
	 * of one table, which is what makes a sweep across several models worth reading.
	 *
	 * @param report The full benchmark report to render.
	 * @returns The whole report as one markdown document.
	 */
	private static _renderMarkdownReport(report: BenchmarkReport): string {
		const rows = report.summaries.map((summary) => [
			'|',
			summary.baseUrl,
			'|',
			summary.modelId,
			`| ${ReportRenderer._rounded(summary.timeToFirstCharacterMs.average)} ms`,
			`| ${ReportRenderer._rounded(summary.timeToLastCharacterMs.average)} ms`,
			`| ${ReportRenderer._rounded(summary.outputCharactersPerSecond.average)} chars/s`,
			`| ${summary.inputCharacters}`,
			`| ${ReportRenderer._rounded(summary.outputCharacters.average)} |`,
		].join(' '));
		const blocks: string[] = [
			'# OpenAI API benchmark',
			`Parallelism: ${report.settings.parallelism} · measured requests: ${report.settings.runs} · warm-up requests: ${report.settings.warmupRuns}`,
			[
				'| Base URL | Model | Time to First Character | Time to Last Character | Output Characters per Second | Input Characters | Output Characters |',
				'| --- | --- | ---: | ---: | ---: | ---: | ---: |',
				...rows,
			].join('\n'),
		];
		return `${blocks.join('\n\n')}\n`;
	}
}
