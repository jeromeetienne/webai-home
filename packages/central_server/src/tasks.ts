import type { StageName, StageResult, Task, TaskInput } from "@webai/protocol";

export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  create(input: TaskInput): Task {
    const now = new Date().toISOString();
    const task: Task = { id: crypto.randomUUID(), input, state: "queued", stages: [], createdAt: now, updatedAt: now };
    this.tasks.set(task.id, task);
    return task;
  }
  get(id: string): Task | undefined { return this.tasks.get(id); }
  update(id: string, update: Partial<Task>): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} was not found`);
    const next = { ...task, ...update, updatedAt: new Date().toISOString() };
    this.tasks.set(id, next);
    return next;
  }
  addStage(id: string, stage: StageResult): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} was not found`);
    return this.update(id, { stages: [...task.stages, stage] });
  }
}

export function nextStage(task: Task): StageName | undefined {
  return task.stages.length === 0 ? "multiply" : task.stages.length === 1 ? "add" : undefined;
}
