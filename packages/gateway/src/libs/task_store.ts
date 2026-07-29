// npm imports
import type { AssignmentRetryReason, StageAssignment, StageName, StagePayload, StageResult, Task, TaskInput } from "@webai/protocol";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Stores task state for the lifetime of the gateway process. */
export class TaskStore {
	private readonly tasks = new Map<string, Task>();
	private readonly taskIdByConsumerRequest = new Map<string, string>();
	constructor(private readonly now: () => Date = () => new Date(), private readonly submissionTimeoutMs = 30_000, private readonly leaseMs = 15_000, private readonly stateFilePath?: string) {
		this.restore();
	}

	/**
	 * Creates and stores a queued task.
	 *
	 * @param input - The validated input submitted for the task.
	 * @returns The newly created task.
	 */
	create(input: TaskInput, consumerDeviceId = "consumer-unknown", requestId: string = crypto.randomUUID(), consumerPrincipal?: string, pipeline?: Pick<Task, "pipelineId" | "pipelineVersion" | "pipelineStages">): Task {
		const now = this.now().toISOString();
		const task: Task = {
			taskId: `task-${crypto.randomUUID()}`,
			requestId,
			consumerDeviceId,
			...(consumerPrincipal === undefined ? {} : { consumerPrincipal }),
			...(pipeline ?? {}),
			input,
			state: "queued",
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

	findByRequest(consumerDeviceId: string, requestId: string): Task | undefined {
		const taskId = this.taskIdByConsumerRequest.get(this.requestKey(consumerDeviceId, requestId));
		return taskId === undefined ? undefined : this.tasks.get(taskId);
	}

	assign(taskId: string, workerDeviceId: string, stage: StageName, value: StagePayload, retryReason?: AssignmentRetryReason): Task {
		const task = this.get(taskId);
		if (!task) throw new Error(`Task ${taskId} was not found`);
		const assignment: StageAssignment = {
			workerDeviceId,
			assignmentId: `assignment-${crypto.randomUUID()}`,
			attempt: task.currentStageAttempts + 1,
			stage,
			value,
			leaseUntil: new Date(this.now().getTime() + this.leaseMs).toISOString(),
			...(retryReason === undefined ? {} : { retryReason }),
		};
		return this.update(taskId, {
			state: "assigned",
			assignment,
			assignmentAttempts: [...task.assignmentAttempts, assignment],
			currentStageAttempts: assignment.attempt,
			events: [...task.events, { type: retryReason === undefined ? "assignment_created" : "assignment_retried", timestamp: this.now().toISOString(), reason: retryReason, assignmentId: assignment.assignmentId, attempt: assignment.attempt }],
		});
	}

	acceptAssignment(taskId: string): Task {
		const task = this.required(taskId);
		if (!task.assignment) throw new Error(`Task ${taskId} has no active assignment`);
		const acceptedAt = this.now().toISOString();
		const assignment = { ...task.assignment, acceptedAt };
		return this.update(taskId, { state: "running", assignment, assignmentAttempts: task.assignmentAttempts.map((item) => item.assignmentId === assignment.assignmentId ? assignment : item), events: [...task.events, { type: "assignment_accepted", timestamp: acceptedAt, assignmentId: assignment.assignmentId, attempt: assignment.attempt }] });
	}

	cancel(taskId: string, reason: string): Task {
		const task = this.required(taskId);
		return this.update(taskId, { state: "cancelled", error: reason, assignment: undefined, events: [...task.events, { type: "task_cancelled", timestamp: this.now().toISOString(), reason }] });
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
		if (!task) {
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
	 * @param taskId - The task identifier to update.
	 * @param stage - The completed stage result to append.
	 * @returns The updated task.
	 * @throws Error when the task identifier is not stored.
	 */
	addStage(taskId: string, stage: StageResult, assignmentId?: string): Task {
		const task = this.tasks.get(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} was not found`);
		}
		return this.update(taskId, {
			completedStages: [...task.completedStages, stage],
			assignment: undefined,
			currentStageAttempts: 0,
			...(assignmentId === undefined ? {} : { acknowledgedAssignmentIds: [...(task.acknowledgedAssignmentIds ?? []), assignmentId] }),
		});
	}

	private requestKey(consumerDeviceId: string, requestId: string): string {
		return `${consumerDeviceId}\u0000${requestId}`;
	}

	private required(taskId: string): Task {
		const task = this.get(taskId);
		if (!task) throw new Error(`Task ${taskId} was not found`);
		return task;
	}

	/** Restores the versioned, local durable state before the gateway accepts traffic. */
	private restore(): void {
		if (!this.stateFilePath || !existsSync(this.stateFilePath)) return;
		const document = JSON.parse(readFileSync(this.stateFilePath, "utf8")) as { schemaVersion: number; tasks: Task[] };
		if (document.schemaVersion !== 1 || !Array.isArray(document.tasks)) throw new Error(`Unsupported task state schema in ${this.stateFilePath}`);
		for (const task of document.tasks) {
			const restored = { ...task, currentStageAttempts: task.currentStageAttempts ?? task.assignment?.attempt ?? 0 };
			this.tasks.set(restored.taskId, restored);
			this.taskIdByConsumerRequest.set(this.requestKey(restored.consumerDeviceId, restored.requestId), restored.taskId);
		}
	}

	/** Writes through a temporary file so a process interruption cannot leave partial JSON. */
	private persist(): void {
		if (!this.stateFilePath) return;
		const temporaryPath = `${this.stateFilePath}.tmp`;
		writeFileSync(temporaryPath, JSON.stringify({ schemaVersion: 1, tasks: this.list() }), "utf8");
		renameSync(temporaryPath, this.stateFilePath);
	}

	/**
	 * Determines the next processing stage for a task.
	 *
	 * The formula sequence runs each of its two stages once. The LLM sequence instead
	 * cycles through its three shards once per generated token, looping back to
	 * `stage_llm_shard1` after `stage_llm_shard3` until that shard's result payload
	 * reports `done: true` (an end-of-sequence token or the token limit was reached).
	 *
	 * @param task - The task whose completed stages are inspected.
	 * @returns The next stage, or `undefined` when all stages are complete.
	 */
	static nextStage(task: Task): StageName | undefined {
		if (task.pipelineStages) return task.pipelineStages[task.completedStages.length];
		if (task.input.taskType === "task_type_formula") {
			const stageSequence: StageName[] = ["stage_formula_multiply", "stage_formula_add"];
			return stageSequence[task.completedStages.length];
		}

		const stageSequence: StageName[] = ["stage_llm_shard1", "stage_llm_shard2", "stage_llm_shard3"];
		const lastCompleted = task.completedStages.at(-1);
		const lastValue = lastCompleted?.value;
		const isGenerationDone = lastCompleted?.name === "stage_llm_shard3"
			&& typeof lastValue === "object"
			&& lastValue?.done === true;
		if (isGenerationDone) return undefined;
		return stageSequence[task.completedStages.length % stageSequence.length];
	}
}
