import { z } from 'zod';
import { Identifier, StageAssignmentId } from '../identifier.js';
import { StageName } from '../task/pipeline_types.js';
import { AccountId } from './account_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LedgerTypes — one accounting event, and what a run of them adds up to
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * How much one accounting event changes an account's balance.
 *
 * Version 1 has one rule and no pricing: a completed stage earns the worker one credit and costs
 * the consumer one credit. Nothing else is representable on purpose, so a change that starts
 * charging by execution duration or by graphics processing unit capability has to widen this
 * definition, rather than quietly writing a larger number into the same ledger.
 */
export const CreditDelta = z.union([z.literal(1), z.literal(-1)]);
/** How much one accounting event changes an account's balance: `+1` or `-1`. */
export type CreditDelta = z.infer<typeof CreditDelta>;

/** Which side of the ledger to read: what an account earned, what it spent, or all of it. */
export const LedgerDirection = z.enum(['earned', 'spent', 'both']);
/** Which side of the ledger to read: what an account earned, what it spent, or all of it. */
export type LedgerDirection = z.infer<typeof LedgerDirection>;

/**
 * One accounting event: one completed stage, seen from one account.
 *
 * A completed stage produces two entries, not one — the worker earns and the consumer spends — so an
 * entry names the account it belongs to and carries the same task, stage, and assignment identifiers
 * as its counterpart. That is what lets one stage be followed from either side.
 *
 * An entry is never edited and never deleted. A balance is what its account's entries add up to, so
 * there is no stored balance that could disagree with the history behind it.
 */
export const LedgerEntrySchema = z.object({
	/** This entry's own identifier, which a reader also uses as a paging cursor. */
	ledgerEntryId: Identifier,
	/** When the gateway recorded it, as an ISO 8601 timestamp. */
	recordedAt: z.string().min(1).max(40),
	/** The account whose balance this entry changes. */
	accountId: AccountId,
	/** `+1` for the worker that completed the stage, `-1` for the consumer that submitted the task. */
	creditDelta: CreditDelta,
	/** The task the completed stage belongs to. */
	taskId: Identifier,
	/** The stage that completed. */
	stageName: StageName,
	/** The assignment the completed stage result answered. */
	stageAssignmentId: StageAssignmentId,
	/** The worker device that ran the stage. */
	workerDeviceId: Identifier,
	/** The consumer device that submitted the task. */
	consumerDeviceId: Identifier,
	/**
	 * How long the stage took, in milliseconds, when the gateway could measure it.
	 *
	 * This is recorded because it is worth having and costs nothing to keep. It has no effect on any
	 * balance in Version 1, where every completed stage is worth exactly one credit however long it
	 * took.
	 */
	stageDurationMs: z.number().int().nonnegative().optional(),
}).strict();
/** One accounting event: one completed stage, seen from one account. */
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** What one account's ledger entries add up to. */
export type AccountLedgerSummary = {
	/** The account this summary is for. */
	accountId: string;
	/** What the account's entries add up to: stages earned minus stages spent. */
	balance: number;
	/** How many stages this account completed as a worker. */
	earnedStageCount: number;
	/** How many stages this account had run as a consumer. */
	spentStageCount: number;
};
