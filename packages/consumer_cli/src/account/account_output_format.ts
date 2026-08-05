///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountOutputFormat — how the five accounting commands write their answers out
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The ways an accounting command can write its answer out. */
export type AccountOutputFormat = 'text' | 'json';

/** Every format an accounting command accepts, in the order the help text lists them. */
export const accountOutputFormats: AccountOutputFormat[] = ['text', 'json'];

/** Checks and formats the output of the five accounting commands. */
export class AccountOutputFormatter {
	/**
	 * Reports whether some text names a format these commands accept.
	 *
	 * @param value The text given on the command line.
	 * @returns `true` when it is one of the formats.
	 */
	static isFormat(value: string): value is AccountOutputFormat {
		return (accountOutputFormats as string[]).includes(value);
	}

	/**
	 * Writes one answer out, either as lines of `label: value` or as JSON.
	 *
	 * @param rows The labels and values to print, in the order they should appear.
	 * @param jsonValue What the same answer is as JSON.
	 * @param format Which of the two the caller asked for.
	 * @returns The text to print.
	 */
	static format(rows: [string, string][], jsonValue: unknown, format: AccountOutputFormat): string {
		if (format === 'json') {
			return JSON.stringify(jsonValue, undefined, '\t');
		}
		const width = Math.max(...rows.map(([label]) => label.length));
		return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
	}
}
