import type { LedgerEntry, StageName, Task } from '@webai/protocol';
import type { SessionRegistry } from '../task/session_registry.js';
import type { LedgerStore } from './ledger_store.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountingRecorder — one completed stage earns one credit and costs one credit
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One completed stage, as the gateway knows it at the moment the result is accepted. */
export type CompletedStage = {
	/** The task the stage belongs to, read for the task identifier and the consumer. */
	task: Task;
	/** The stage that completed. */
	stageName: StageName;
	/** The assignment the result answered. */
	stageAssignmentId: string;
	/** The worker device that ran the stage. */
	workerDeviceId: string;
	/**
	 * How long the worker held the assignment, in milliseconds, when that could be measured.
	 *
	 * It is recorded and changes nothing: in Version 1 every completed stage is worth exactly one
	 * credit however long it took.
	 */
	stageDurationMs?: number | undefined;
};

/** The two entries one completed stage produces. */
export type CompletedStageAccounting = {
	/** The `+1` recorded against the worker that completed the stage. */
	workerEntry: LedgerEntry;
	/** The `-1` recorded against the consumer that submitted the task. */
	consumerEntry: LedgerEntry;
};

/**
 * Holds the two accounting rules of Version 1, and nothing else.
 *
 * > One completed stage earns the worker one credit, and costs the consumer one credit.
 *
 * There is no pricing here, and nothing to configure. The central processing unit, the graphics
 * processing unit, the execution duration, the memory used, and the number of floating point
 * operations all have no effect: every completed stage is worth the same. That is what makes the
 * whole ledger two lines of arithmetic, and it is the decision recorded in
 * https://github.com/webai-at-home/webai-at-home/issues/122.
 *
 * Nothing is recorded for a stage that fails, is relinquished, or has its lease expire, because
 * this is only ever called with a stage that completed. An unfinished attempt therefore earns
 * nothing and costs nothing, and a stage retried until it completes produces exactly one credit
 * and one debit, because one completion is what happened.
 */
export class AccountingRecorder {
	/**
	 * The account every participant that has authenticated no account of its own is recorded against.
	 *
	 * The gateway's shared token says nothing about who presented it, so the work of a participant
	 * that has only presented that token cannot be attributed to anybody. It is recorded here rather
	 * than dropped, so that the gateway's own development runs still produce a readable ledger, and
	 * it is deliberately not shaped like a real account identifier — those are digests of a public
	 * key, and hold nothing but hexadecimal — so nobody can mistake it for a participant.
	 */
	static readonly sharedDevelopmentAccountId = 'account-shared-development';

	/**
	 * @param ledgerStore The append-only ledger both entries are written to.
	 * @param sessionRegistry The sessions a worker's account is read from. It is read at the moment
	 * the stage completes, because that is when the worker is certainly still connected: it has just
	 * sent its result.
	 */
	constructor(private readonly ledgerStore: LedgerStore, private readonly sessionRegistry: SessionRegistry) { }

	/**
	 * Records the two entries one completed stage produces.
	 *
	 * @param completedStage The stage that completed.
	 * @returns The two entries as they were written.
	 */
	recordCompletedStage(completedStage: CompletedStage): CompletedStageAccounting {
		const shared = {
			taskId: completedStage.task.taskId,
			stageName: completedStage.stageName,
			stageAssignmentId: completedStage.stageAssignmentId,
			workerDeviceId: completedStage.workerDeviceId,
			consumerDeviceId: completedStage.task.consumerDeviceId,
			...(completedStage.stageDurationMs === undefined ? {} : { stageDurationMs: completedStage.stageDurationMs }),
		};
		return {
			workerEntry: this.ledgerStore.append({
				...shared,
				accountId: this.workerAccountId(completedStage.workerDeviceId),
				creditDelta: 1,
			}),
			consumerEntry: this.ledgerStore.append({
				...shared,
				accountId: completedStage.task.consumerAccountId ?? AccountingRecorder.sharedDevelopmentAccountId,
				creditDelta: -1,
			}),
		};
	}

	/**
	 * Reads which account a worker's completed stage earns for.
	 *
	 * @param workerDeviceId The worker that ran the stage.
	 * @returns The worker's account, or the shared development account when that connection has
	 * authenticated none.
	 */
	private workerAccountId(workerDeviceId: string): string {
		return this.sessionRegistry.active(workerDeviceId)?.accountId ?? AccountingRecorder.sharedDevelopmentAccountId;
	}
}
