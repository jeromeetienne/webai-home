import { z } from "zod";

export const TaskState = z.enum(["queued", "assigned", "running", "completed", "failed", "cancelled"]);
export type TaskState = z.infer<typeof TaskState>;

export const StageName = z.enum(["stage_formula_multiply", "stage_formula_add"]);
export type StageName = z.infer<typeof StageName>;

export const TaskType = z.enum(["task_type_formula", "task_type_llm"]);
export type TaskType = z.infer<typeof TaskType>;

export const TaskInput = z.discriminatedUnion("taskType", [
  z.object({ taskType: z.literal("task_type_formula"), input: z.number().finite() }),
  z.object({ taskType: z.literal("task_type_llm"), input: z.string() }),
]);
export type TaskInput = z.infer<typeof TaskInput>;

export interface StageResult { 
  name: StageName; 
  value: number; 
}
export interface Task { 
  taskId: string; 
  input: TaskInput; 
  state: TaskState; 
  completedStages: StageResult[]; 
  result?: number; 
  error?: string; 
  createdAt: string; 
  updatedAt: string; 
}

export type ClientMessage =
  | { type: "register"; role: "volunteer" | "admin"; name: string; stageNames?: StageName[] }
  | { type: "task.submit"; input: TaskInput }
  | { type: "task.get"; taskId: string }
  | { type: "stage.result"; taskId: string; stage: StageName; value: number }
  | { type: "stage.failed"; taskId: string; stage: StageName; error: string }
  | { type: "signal"; to: string; data: unknown };

export type ServerMessage =
  | { type: "registered"; deviceId: string }
  | { type: "task.accepted"; task: Task }
  | { type: "task.updated"; task: Task }
  | { type: "stage.assign"; taskId: string; stage: StageName; value: number; peerId?: string }
  | { type: "signal"; from: string; data: unknown }
  | { type: "devices"; devices: Device[] }
  | { type: "error"; message: string };

export const DeviceRole = z.enum(["volunteer", "admin"]);
export type DeviceRole = z.infer<typeof DeviceRole>;

export interface Device { 
  deviceId: string; 
  name: string; 
  deviceRole: DeviceRole; 
  stageNames: StageName[];
  connectedAt: string; 
  lastSeenAt: string; 
}
