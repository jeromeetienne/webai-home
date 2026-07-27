import type { StageName, StageResult, Task, TaskInput } from "@webai/protocol";

export class TaskStore {
	private readonly tasks = new Map<string, Task>();
	create(input: TaskInput): Task {
		const now = new Date().toISOString();
		const task: Task = { taskId: `task-${crypto.randomUUID()}`, input, state: "queued", completedStages: [], createdAt: now, updatedAt: now };
		this.tasks.set(task.taskId, task);
		return task;
	}
	get(taskId: string): Task | undefined { return this.tasks.get(taskId); }
	update(taskId: string, update: Partial<Task>): Task {
		const task = this.tasks.get(taskId);
		if (!task) throw new Error(`Task ${taskId} was not found`);
		const next = { ...task, ...update, updatedAt: new Date().toISOString() };
		this.tasks.set(taskId, next);
		return next;
	}
	addStage(taskId: string, stage: StageResult): Task {
		const task = this.tasks.get(taskId);
		if (!task) throw new Error(`Task ${taskId} was not found`);
		return this.update(taskId, { completedStages: [...task.completedStages, stage] });
	}
}

export function nextStage(task: Task): StageName | undefined {
	return task.completedStages.length === 0 ? "multiply" : task.completedStages.length === 1 ? "add" : undefined;
}
