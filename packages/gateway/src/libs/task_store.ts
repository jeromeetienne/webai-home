// npm imports
import type { StageName, StageResult, Task, TaskInput } from "@webai/protocol";

/** Stores task state for the lifetime of the gateway process. */
export class TaskStore {
	private readonly tasks = new Map<string, Task>();

	/**
	 * Creates and stores a queued task.
	 *
	 * @param input - The validated input submitted for the task.
	 * @returns The newly created task.
	 */
	create(input: TaskInput): Task {
		const now = new Date().toISOString();
		const task: Task = {
			taskId: `task-${crypto.randomUUID()}`,
			input,
			state: "queued",
			completedStages: [],
			createdAt: now,
			updatedAt: now,
		};
		this.tasks.set(task.taskId, task);
		return task;
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
			updatedAt: new Date().toISOString(),
		};
		this.tasks.set(taskId, next);
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
	addStage(taskId: string, stage: StageResult): Task {
		const task = this.tasks.get(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} was not found`);
		}
		return this.update(taskId, {
			completedStages: [...task.completedStages, stage],
		});
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
