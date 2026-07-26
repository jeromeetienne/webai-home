import { z } from "zod";

export const TaskState = z.enum(["queued", "assigned", "running", "completed", "failed", "cancelled"]);
export type TaskState = z.infer<typeof TaskState>;

export const StageName = z.enum(["multiply", "add"]);
export type StageName = z.infer<typeof StageName>;

export const TaskInput = z.object({ input: z.number().finite() });
export type TaskInput = z.infer<typeof TaskInput>;

export interface StageResult { name: StageName; value: number; }
export interface Task { id: string; input: TaskInput; state: TaskState; stages: StageResult[]; result?: number; error?: string; createdAt: string; updatedAt: string; }

export type ClientMessage =
  | { type: "register"; role: "volunteer" | "admin"; name: string; capabilities?: StageName[] }
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

export interface Device { id: string; name: string; role: "volunteer" | "admin"; capabilities: StageName[]; connectedAt: string; lastSeenAt: string; }
