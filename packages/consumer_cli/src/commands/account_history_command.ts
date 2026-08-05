import type { LedgerDirection, LedgerEntry } from '@webai/protocol';
import { AccountClient, type AccountClientOptions } from '../account/account_client.js';
import { AccountOutputFormatter, type AccountOutputFormat } from '../account/account_output_format.js';
import { CliError } from '../libs/cli_errors.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountHistoryCommand — prints the accounting entries of this account, newest first
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every direction `account_history` accepts, in the order the help text lists them. */
export const accountHistoryDirections: LedgerDirection[] = ['earned', 'spent', 'both'];

/** What `consumer_cli account_history` needs to connect and which entries to print. */
export type AccountHistoryCommandOptions = AccountClientOptions & {
	/**
	 * Which side of the ledger to print: the stages this account completed as a worker, the stages it
	 * had run as a consumer, or both.
	 */
	direction: LedgerDirection;
	/** How many entries to print at most. */
	limit: number;
	/** Whether to keep asking for further pages until the whole history has been printed. */
	isEverythingRequested: boolean;
	/** How to write the answer out. */
	format: AccountOutputFormat;
};

/**
 * Prints this account's accounting entries, newest first.
 *
 * `--direction earned` is the list of stages this account completed, and `--direction spent` is the
 * list of stages it had run, which is why there is no separate command for either.
 */
export class AccountHistoryCommand {
	/**
	 * Reports whether some text names a direction this command accepts.
	 *
	 * @param value The text given on the command line.
	 * @returns `true` when it is one of the directions.
	 */
	static isDirection(value: string): value is LedgerDirection {
		return (accountHistoryDirections as string[]).includes(value);
	}

	/**
	 * Runs the command.
	 *
	 * @param options Where to connect, which entries to print, and how.
	 * @returns Nothing.
	 * @throws {CliError} If the connection, the token, or the account is refused.
	 */
	static async run(options: AccountHistoryCommandOptions): Promise<void> {
		const client = new AccountClient(options);
		try {
			await client.connect();
			const accountId = await client.authenticateAccount();
			const entries: LedgerEntry[] = [];
			let cursor: string | undefined;
			let isMoreLeftUnread = false;
			do {
				const answer = await client.request({ type: 'account.ledger.get', direction: options.direction, limit: options.limit, ...(cursor === undefined ? {} : { before: cursor }) });
				if (answer.type !== 'account.ledger') {
					throw new CliError(`The central gateway answered account.ledger.get with ${answer.type}`, 4);
				}
				entries.push(...answer.entries);
				cursor = answer.nextCursor;
				isMoreLeftUnread = cursor !== undefined;
			} while (options.isEverythingRequested && cursor !== undefined);

			console.log(AccountHistoryCommand._format(accountId, options, entries, isMoreLeftUnread));
		} finally {
			client.close();
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Formatting
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Lays the entries out as a table, or hands them back as JSON.
	 *
	 * @param accountId The account whose history this is.
	 * @param options What was asked for, read for the direction and the format.
	 * @param entries The entries that arrived, newest first.
	 * @param isMoreLeftUnread Whether the gateway holds further entries this command did not print.
	 * @returns The text to print.
	 */
	private static _format(accountId: string, options: AccountHistoryCommandOptions, entries: LedgerEntry[], isMoreLeftUnread: boolean): string {
		if (options.format === 'json') {
			return JSON.stringify({
				accountId,
				direction: options.direction,
				entries,
				isMoreLeftUnread,
			}, undefined, '\t');
		}
		if (entries.length === 0) {
			return `${accountId} has no ${options.direction === 'both' ? '' : `${options.direction} `}accounting entries yet.`;
		}
		const rows = entries.map((entry) => [
			entry.recordedAt,
			entry.creditDelta > 0 ? '+1' : '-1',
			entry.stageName,
			entry.taskId,
			entry.stageDurationMs === undefined ? '' : `${String(entry.stageDurationMs)}ms`,
		]);
		const headings = ['recorded at', 'credit', 'stage', 'task', 'stage took'];
		const widths = headings.map((heading, column) => Math.max(heading.length, ...rows.map((row) => (row[column] ?? '').length)));
		const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
		const lines = [
			`${accountId}, ${options.direction === 'both' ? 'everything' : options.direction}, newest first`,
			'',
			line(headings),
			line(widths.map((width) => '-'.repeat(width))),
			...rows.map((row) => line(row)),
		];
		if (isMoreLeftUnread) {
			lines.push('', `Further entries exist. Raise --limit, or pass --all to print the whole history.`);
		}
		return lines.join('\n');
	}
}
