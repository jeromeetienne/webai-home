// npm imports
import type { AssignmentRetryReason, StageAssignment, StageName, StagePayload, StageResult, Task, TaskInput } from '@webai/protocol';
import Fs from 'node:fs';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TaskStore — holds every task and its stage assignments, and keeps them on disk
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Stores task state for the lifetime of the gateway process. */
export class TaskStore {
	private readonly tasks = new Map<string, Task>();
	private readonly taskIdByConsumerRequest = new Map<string, string>();
	/**
	 * @param now Where the current time is read from. Tests pass their own.
	 * @param submissionTimeoutMs How long a queued task may wait before it is failed.
	 * @param leaseMs How long an assignment lease lasts, unless its stage states otherwise.
	 * @param stateFilePath Where durable state is kept. Left out, nothing is written to disk.
	 */
	constructor(private readonly now: () => Date = () => new Date(), private readonly submissionTimeoutMs = 30_000, private readonly leaseMs = 15_000, private readonly stateFilePath?: string) {
		this.restore();
	}

	/**
	 * Creates and stores a queued task.
	 *
	 * @param input - The validated input submitted for the task.
	 * @returns The newly created task.
	 */
	create(input: TaskInput, consumerDeviceId = 'consumer-unknown', requestId: string = crypto.randomUUID(), consumerPrincipal?: string, pipeline?: Pick<Task, 'pipelineId' | 'pipelineVersion' | 'pipelineStages' | 'pipelineRepeatsUntilDone'>): Task {
		const now = this.now().toISOString();
		const task: Task = {
			taskId: `task-${crypto.randomUUID()}`,
			requestId,
			consumerDeviceId,
			...(consumerPrincipal === undefined ? {} : { consumerPrincipal }),
			...(pipeline ?? {}),
			input,
			state: 'queued',
			completedStages: [],
			assignmentAttempts: [],
			currentStageAttempts: 0,
			events: [],
			revision: 1,
			submissionDeadlineAt: new Date(this.now().getTime() + this.submissionTimeoutMs).toISOString(),
			createdAt: now,
			updatedAt: now,
		};
		this.tasks.set(task.taskId, task);
		this.taskIdByConsumerRequest.set(this.requestKey(consumerDeviceId, requestId), task.taskId);
		this.persist();
		return task;
	}

	/**
	 * Finds the task a consumer already created with one request identifier.
	 *
	 * @param consumerDeviceId The consumer that submitted it.
	 * @param requestId The identifier that consumer gave its submission.
	 * @returns The existing task, or `undefined` when that request is new.
	 */
	findByRequest(consumerDeviceId: string, requestId: string): Task | undefined {
		const taskId = this.taskIdByConsumerRequest.get(this.requestKey(consumerDeviceId, requestId));
		return taskId === undefined ? undefined : this.tasks.get(taskId);
	}

	/**
	 * Assigns a stage to a worker device.
	 *
	 * @param leaseMs - How long this assignment's lease lasts. Defaults to the store's own
	 * lease duration, which is the gateway's `--lease-ms` value. A stage that states its own
	 * lease in its pipeline specification passes that value here instead.
	 */
	assign(taskId: string, workerDeviceId: string, stage: StageName, value: StagePayload, retryReason?: AssignmentRetryReason, leaseMs: number = this.leaseMs): Task {
		const task = this.get(taskId);
		if (task === undefined) throw new Error(`Task ${taskId} was not found`);
		const assignment: StageAssignment = {
			workerDeviceId,
			assignmentId: `assignment-${crypto.randomUUID()}`,
			attempt: task.currentStageAttempts + 1,
			stage,
			value,
			leaseUntil: new Date(this.now().getTime() + leaseMs).toISOString(),
			...(retryReason === undefined ? {} : { retryReason }),
		};
		return this.update(taskId, {
			state: 'assigned',
			assignment,
			assignmentAttempts: [...task.assignmentAttempts, assignment],
			currentStageAttempts: assignment.attempt,
			events: [...task.events, { type: retryReason === undefined ? 'assignment_created' : 'assignment_retried', timestamp: this.now().toISOString(), reason: retryReason, assignmentId: assignment.assignmentId, attempt: assignment.attempt }],
		});
	}

	/**
	 * Records that the assigned worker has accepted its current assignment.
	 *
	 * @param taskId The task whose assignment was accepted.
	 * @returns The updated task, now running.
	 * @throws If the task has no current assignment.
	 */
	acceptAssignment(taskId: string): Task {
		const task = this.required(taskId);
		if (task.assignment === undefined) throw new Error(`Task ${taskId} has no active assignment`);
		const acceptedAt = this.now().toISOString();
		const assignment = { ...task.assignment, acceptedAt };
		return this.update(taskId, { state: 'running', assignment, assignmentAttempts: task.assignmentAttempts.map((item) => item.assignmentId === assignment.assignmentId ? assignment : item), events: [...task.events, { type: 'assignment_accepted', timestamp: acceptedAt, assignmentId: assignment.assignmentId, attempt: assignment.attempt }] });
	}

	/**
	 * Extends the lease of the assignment a task is currently working on.
	 *
	 * This deliberately does not raise the task's revision and does not touch `updatedAt`. A
	 * lease extension says only that the assigned worker is still alive; nothing a consumer
	 * or an observer displays has changed. Raising the revision would send a task update to
	 * every reader on every heartbeat, which is the traffic the slim task projection exists
	 * to avoid.
	 *
	 * @param taskId - The task whose current assignment is being extended.
	 * @param leaseMs - How much longer the lease should last, measured from now.
	 * @returns The new lease expiry, or `undefined` when the task has no current assignment.
	 */
	renewLease(taskId: string, leaseMs: number): string | undefined {
		const task = this.get(taskId);
		if (task?.assignment === undefined) return undefined;
		const leaseUntil = new Date(this.now().getTime() + leaseMs).toISOString();
		const assignment = { ...task.assignment, leaseUntil };
		this.tasks.set(taskId, {
			...task,
			assignment,
			assignmentAttempts: task.assignmentAttempts.map((item) => item.assignmentId === assignment.assignmentId ? assignment : item),
		});
		this.persist();
		return leaseUntil;
	}

	/**
	 * Cancels a task and records why.
	 *
	 * @param taskId The task to cancel.
	 * @param reason Why it was cancelled.
	 * @returns The cancelled task.
	 */
	cancel(taskId: string, reason: string): Task {
		const task = this.required(taskId);
		return this.update(taskId, { state: 'cancelled', error: reason, assignment: undefined, events: [...task.events, { type: 'task_cancelled', timestamp: this.now().toISOString(), reason }] });
	}

	/**
	 * Looks up a task by its identifier.
	 *
	 * @param taskId - The task identifier to look up.
	 * @returns The matching task, or `undefined` when no task exists.
	 */
	get(taskId: string): Task | undefined {
		return this.tasks.get(taskId);
	}

	/** Returns every stored task. */
	list(): Task[] {
		return [...this.tasks.values()];
	}

	/**
	 * Applies a partial update to a stored task.
	 *
	 * @param taskId - The task identifier to update.
	 * @param update - The task fields to replace.
	 * @returns The updated task.
	 * @throws Error when the task identifier is not stored.
	 */
	update(taskId: string, update: Partial<Task>): Task {
		const task = this.tasks.get(taskId);
		if (task === undefined) {
			throw new Error(`Task ${taskId} was not found`);
		}
		const next = {
			...task,
			...update,
			revision: task.revision + 1,
			updatedAt: this.now().toISOString(),
		};
		this.tasks.set(taskId, next);
		this.persist();
		return next;
	}

	/**
	 * Appends a completed stage result to a stored task.
	 *
	 * The device that ran the stage is recorded against the stage name, so that a later run of
	 * that same stage can be placed back on the device holding the state the stage left in
	 * memory. The device is read from the assignment the result completes, so no caller has to
	 * pass it in.
	 *
	 * @param taskId - The task identifier to update.
	 * @param stage - The completed stage result to append.
	 * @returns The updated task.
	 * @throws Error when the task identifier is not stored.
	 */
	addStage(taskId: string, stage: StageResult, assignmentId?: string): Task {
		const task = this.tasks.get(taskId);
		if (task === undefined) {
			throw new Error(`Task ${taskId} was not found`);
		}
		const workerDeviceId = task.assignment?.workerDeviceId;
		return this.update(taskId, {
			completedStages: [...task.completedStages, stage],
			assignment: undefined,
			currentStageAttempts: 0,
			...(workerDeviceId === undefined ? {} : { stageWorkerDeviceIds: { ...(task.stageWorkerDeviceIds ?? {}), [stage.name]: workerDeviceId } }),
			...(assignmentId === undefined ? {} : { acknowledgedAssignmentIds: [...(task.acknowledgedAssignmentIds ?? []), assignmentId] }),
		});
	}

	private requestKey(consumerDeviceId: string, requestId: string): string {
		return `${consumerDeviceId}\u0000${requestId}`;
	}

	private required(taskId: string): Task {
		const task = this.get(taskId);
		if (task === undefined) throw new Error(`Task ${taskId} was not found`);
		return task;
	}

	/** Restores the versioned, local durable state before the gateway accepts traffic. */
	private restore(): void {
		if (this.stateFilePath === undefined || this.stateFilePath === '' || Fs.existsSync(this.stateFilePath) === false) return;
		const document = JSON.parse(Fs.readFileSync(this.stateFilePath, 'utf8')) as { schemaVersion: number; tasks: Task[] };
		if (document.schemaVersion !== 1 || Array.isArray(document.tasks) === false) throw new Error(`Unsupported task state schema in ${this.stateFilePath}`);
		for (const task of document.tasks) {
			const restored = { ...task, currentStageAttempts: task.currentStageAttempts ?? task.assignment?.attempt ?? 0 };
			// A task written by a gateway that built its stage sequence internally carries no
			// pipeline, so it can never be advanced now that the sequence comes from the task's
			// own pipeline. Failing it makes that visible instead of leaving it stuck for ever.
			if (TaskStore._isUnadvanceable(restored)) {
				restored.state = 'failed';
				restored.error = 'NO_PIPELINE_ON_RESTORED_TASK';
				restored.assignment = undefined;
			}
			this.tasks.set(restored.taskId, restored);
			this.taskIdByConsumerRequest.set(this.requestKey(restored.consumerDeviceId, restored.requestId), restored.taskId);
		}
	}

	/**
	 * Reports whether a restored task can still be advanced.
	 *
	 * @param task - The task read back from the durable state file.
	 * @returns `true` when the task is unfinished but carries no pipeline to advance through.
	 */
	private static _isUnadvanceable(task: Task): boolean {
		const isFinished = task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled';
		return isFinished === false && (task.pipelineStages === undefined || task.pipelineStages.length === 0);
	}

	/** Writes through a temporary file so a process interruption cannot leave partial JSON. */
	private persist(): void {
		if (this.stateFilePath === undefined || this.stateFilePath === '') return;
		const temporaryPath = `${this.stateFilePath}.tmp`;
		Fs.writeFileSync(temporaryPath, JSON.stringify({ schemaVersion: 1, tasks: this.list() }), 'utf8');
		Fs.renameSync(temporaryPath, this.stateFilePath);
	}

	/**
	 * Determines the next processing stage for a task.
	 *
	 * The stage sequence comes from the task's own pipeline, which the task carries as
	 * `pipelineStages`. No stage name is written into this function, so a pipeline added
	 * through the gateway's `--pipeline-file` option advances the same way a built-in one
	 * does.
	 *
	 * A pipeline that states `repeatsUntilDone` starts again at its first stage once its last
	 * stage finishes, and ends only when a result reports `done: true`. The language-model
	 * pipeline works this way: its shards run once per generated token, and generation stops
	 * at an end-of-sequence token or the token limit.
	 *
	 * @param task - The task whose completed stages are inspected.
	 * @returns The next stage, or `undefined` when the pipeline has finished.
	 */
	static nextStage(task: Task): StageName | undefined {
		const stageSequence = task.pipelineStages ?? [];
		if (stageSequence.length === 0) return undefined;
		const completedCount = task.completedStages.length;
		if (task.pipelineRepeatsUntilDone !== true) return stageSequence[completedCount];

		const isCycleFinished = completedCount > 0 && completedCount % stageSequence.length === 0;
		const lastValue = task.completedStages.at(-1)?.value;
		const isDone = isCycleFinished && typeof lastValue === 'object' && lastValue?.done === true;
		if (isDone) return undefined;
		return stageSequence[completedCount % stageSequence.length];
	}
}
