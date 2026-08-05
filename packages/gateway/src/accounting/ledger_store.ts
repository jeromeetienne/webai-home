import Fs from 'node:fs';
import Path from 'node:path';
import { LedgerEntrySchema, type AccountLedgerSummary, type CreditDelta, type LedgerDirection, type LedgerEntry } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LedgerStore — appends every accounting event to a file, and never rewrites one
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one accounting event states, before the store gives it an identifier and a timestamp. */
export type LedgerEntryDraft = Omit<LedgerEntry, 'ledgerEntryId' | 'recordedAt'>;

/** Which part of one account's history to read. */
export type LedgerReadOptions = {
	/** Which side of the ledger to read. Defaults to both. */
	direction?: LedgerDirection | undefined;
	/** How many entries to return at most. Defaults to 50, and is capped at 500. */
	limit?: number | undefined;
	/**
	 * Continue from just after this entry.
	 *
	 * It is the `ledgerEntryId` of the last entry of the previous page. Entries are returned newest
	 * first, so continuing means reading the entries recorded before that one.
	 *
	 * It accepts the absent cursor of a last page as well as a real one, so a reader can pass what the
	 * previous page gave it without checking first: no cursor means start at the newest entry.
	 */
	before?: string | undefined;
};

/** One page of one account's history. */
export type LedgerPage = {
	/** The entries, newest first. */
	entries: LedgerEntry[];
	/**
	 * What to pass as `before` to read the next page, when there is one.
	 *
	 * It is absent when this page reached the beginning of the account's history, so a reader stops
	 * when it is absent rather than by comparing counts.
	 */
	nextCursor?: string;
};

/** How many entries a read returns when the caller states no limit. */
const defaultReadLimit = 50;

/** How many entries a read returns at most, however large a limit the caller states. */
const maximumReadLimit = 500;

/**
 * Holds every accounting event, as an append-only file of one JSON object per line.
 *
 * Nothing here is ever rewritten or deleted, which is the whole point: a balance is what an
 * account's entries add up to, so there is no stored balance that could drift away from the history
 * behind it, and every credit and debit can be traced back to the completed stage that caused it.
 *
 * This is deliberately not kept in the gateway's durable task state file. `TaskStore` writes that
 * file whole, through a temporary file, on every single mutation, which is reasonable for a bounded
 * set of tasks and wrong for a ledger: a hundred-token answer from the sharded language-model
 * pipeline records six hundred entries, and rewriting the entire history to add the next line would
 * cost more with every line added.
 *
 * Balances are held in memory and are rebuilt by reading the file once at start-up, so answering
 * "what is my balance" never touches the disk. History is read from the file instead, because
 * holding every entry of an unbounded ledger in memory is exactly what the append-only file exists
 * to avoid. A read of one account's history therefore scans the file, which is acceptable while a
 * ledger is small and is the first thing to change when it is not.
 */
export class LedgerStore {
	/** The running total of each account, by account identifier. */
	private readonly summariesByAccountId = new Map<string, AccountLedgerSummary>();

	/**
	 * @param ledgerFilePath The append-only file every entry is written to. It is required: a ledger
	 * kept only in memory would report balances that vanish when the gateway restarts, which for
	 * accounting is worse than refusing to start.
	 * @param now Where the current time is read from. Tests pass their own.
	 * @param newLedgerEntryId Where an entry identifier comes from. Tests pass their own so that a
	 * recorded page can be compared exactly.
	 */
	constructor(
		private readonly ledgerFilePath: string,
		private readonly now: () => Date = () => new Date(),
		private readonly newLedgerEntryId: () => string = () => `ledgerEntry-${crypto.randomUUID()}`,
	) {
		if (ledgerFilePath === '') {
			throw new Error('A ledger file path is required, because a ledger held only in memory would lose every balance when the gateway restarts');
		}
		this.restore();
	}

	/**
	 * Records one accounting event, and returns the entry as it was written.
	 *
	 * @param draft What the event states. The identifier and the timestamp are added here, so no
	 * caller has to invent either.
	 * @returns The entry that was appended.
	 */
	append(draft: LedgerEntryDraft): LedgerEntry {
		const entry: LedgerEntry = {
			ledgerEntryId: this.newLedgerEntryId(),
			recordedAt: this.now().toISOString(),
			...draft,
		};
		Fs.mkdirSync(Path.dirname(this.ledgerFilePath), { recursive: true });
		Fs.appendFileSync(this.ledgerFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
		this.addToSummary(entry);
		return entry;
	}

	/**
	 * Reports what one account's entries add up to.
	 *
	 * @param accountId The account to report on.
	 * @returns The summary. An account with no entries has a balance of zero rather than no answer,
	 * because an account that has neither earned nor spent anything is a real state and not a missing
	 * one.
	 */
	summaryFor(accountId: string): AccountLedgerSummary {
		return this.summariesByAccountId.get(accountId) ?? {
			accountId,
			balance: 0,
			earnedStageCount: 0,
			spentStageCount: 0,
		};
	}

	/** Returns a summary for every account that has at least one entry. */
	summaries(): AccountLedgerSummary[] {
		return [...this.summariesByAccountId.values()];
	}

	/**
	 * Reads one page of one account's history, newest first.
	 *
	 * @param accountId The account whose history to read.
	 * @param options Which side of the ledger, how many entries, and where to continue from.
	 * @returns The page, and the cursor to continue from when there is more.
	 */
	entriesFor(accountId: string, options: LedgerReadOptions = {}): LedgerPage {
		const direction = options.direction ?? 'both';
		const limit = Math.min(Math.max(options.limit ?? defaultReadLimit, 1), maximumReadLimit);
		const matching = this.readAll()
			.filter((entry) => entry.accountId === accountId)
			.filter((entry) => LedgerStore.matchesDirection(entry.creditDelta, direction))
			.reverse();

		const start = options.before === undefined
			? 0
			: matching.findIndex((entry) => entry.ledgerEntryId === options.before) + 1;
		// A cursor naming an entry this account does not have starts at the beginning rather than
		// silently returning the newest page, so a reader cannot mistake a stale cursor for progress.
		const page = start === 0 && options.before !== undefined ? [] : matching.slice(start, start + limit);
		const isMore = start + page.length < matching.length;
		const lastEntryId = page.at(-1)?.ledgerEntryId;
		return {
			entries: page,
			...(isMore && lastEntryId !== undefined ? { nextCursor: lastEntryId } : {}),
		};
	}

	/**
	 * Reads every entry in the file, in the order they were recorded.
	 *
	 * A line this gateway cannot read stops the read loudly, naming the line, rather than being
	 * skipped. A ledger that quietly drops what it cannot parse reports a balance that is wrong by
	 * however much it dropped, and it would report it with no sign that anything was missing.
	 *
	 * @returns Every entry, oldest first.
	 */
	readAll(): LedgerEntry[] {
		if (Fs.existsSync(this.ledgerFilePath) === false) {
			return [];
		}
		const lines = Fs.readFileSync(this.ledgerFilePath, 'utf8').split('\n');
		const entries: LedgerEntry[] = [];
		for (const [index, line] of lines.entries()) {
			if (line.trim() === '') {
				continue;
			}
			try {
				entries.push(LedgerEntrySchema.parse(JSON.parse(line)));
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`Unreadable accounting ledger entry at ${this.ledgerFilePath} line ${index + 1}: ${reason}`);
			}
		}
		return entries;
	}

	/**
	 * Rebuilds every balance from the file, before the gateway accepts traffic.
	 *
	 * @returns Nothing.
	 */
	private restore(): void {
		for (const entry of this.readAll()) {
			this.addToSummary(entry);
		}
	}

	/**
	 * Adds one entry to its account's running total.
	 *
	 * @param entry The entry that was recorded.
	 */
	private addToSummary(entry: LedgerEntry): void {
		const summary = this.summariesByAccountId.get(entry.accountId) ?? {
			accountId: entry.accountId,
			balance: 0,
			earnedStageCount: 0,
			spentStageCount: 0,
		};
		this.summariesByAccountId.set(entry.accountId, {
			accountId: entry.accountId,
			balance: summary.balance + entry.creditDelta,
			earnedStageCount: summary.earnedStageCount + (entry.creditDelta === 1 ? 1 : 0),
			spentStageCount: summary.spentStageCount + (entry.creditDelta === -1 ? 1 : 0),
		});
	}

	/**
	 * Reports whether one entry belongs on the side of the ledger a reader asked for.
	 *
	 * @param creditDelta What the entry did to the balance.
	 * @param direction Which side the reader asked for.
	 * @returns `true` when the entry belongs in the answer.
	 */
	private static matchesDirection(creditDelta: CreditDelta, direction: LedgerDirection): boolean {
		if (direction === 'earned') {
			return creditDelta === 1;
		}
		if (direction === 'spent') {
			return creditDelta === -1;
		}
		return true;
	}
}
