import { z } from "zod";

export const TaskState = z.enum(["queued", "assigned", "running", "completed", "failed", "cancelled"]);
export type TaskState = z.infer<typeof TaskState>;

export const StageName = z.enum([
  "stage_formula_multiply",
  "stage_formula_add",
  "stage_llm_shard1",
  "stage_llm_shard2",
  "stage_llm_shard3",
]);
export type StageName = z.infer<typeof StageName>;

export const TaskType = z.enum(["task_type_formula", "task_type_llm"]);
export type TaskType = z.infer<typeof TaskType>;

export const TaskInput = z.discriminatedUnion("taskType", [
  z.object({ taskType: z.literal("task_type_formula"), input: z.number().finite() }),
  z.object({ taskType: z.literal("task_type_llm"), input: z.string() }),
]);
export type TaskInput = z.infer<typeof TaskInput>;

/**
 * A named tensor carried inside a stage payload, encoded as text so it can travel
 * inside a JSON message. This is the probe encoding for the step-0 de-risking test
 * in https://github.com/jeromeetienne/webai-at-home/issues/9 — not a final format.
 */
export interface EncodedTensor {
  dims: number[];
  type: string;
  dataBase64: string;
}

/**
 * The payload handed between LLM shard stages: the shard's hand-off tensors, and
 * (on the final shard) the generated text.
 */
export interface LlmStagePayload {
  tensors?: Record<string, EncodedTensor>;
  text?: string;
  /** Token identifiers for the sequence positions covered by this stage payload's tensors. */
  inputIds?: number[];
  /** Position of the first token in `inputIds` within the full generated sequence. */
  position?: number;
  /** Set by the final shard once generation should stop (end-of-sequence token or the token limit reached). */
  done?: boolean;
}

/** The value carried by one stage: a plain number for the formula pipeline, or an LLM payload. */
export type StagePayload = number | LlmStagePayload;

export interface StageResult {
  name: StageName;
  value: StagePayload;
}
export interface Task {
  taskId: string;
  input: TaskInput;
  state: TaskState;
  completedStages: StageResult[];
  result?: StagePayload;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type ClientMessage =
  | { type: "register"; role: "worker" | "admin"; name: string; stageNames?: StageName[] }
  | { type: "task.submit"; input: TaskInput }
  | { type: "task.get"; taskId: string }
  | { type: "stage.result"; taskId: string; stage: StageName; value: StagePayload }
  | { type: "stage.failed"; taskId: string; stage: StageName; error: string }
  | { type: "signal"; to: string; data: unknown }
  | { type: "log.entry"; direction: "received" | "sent"; messageType: string; timestamp: string; payload: unknown };

export type GatewayMessage =
  | { type: "registered"; deviceId: string }
  | { type: "task.accepted"; task: Task }
  | { type: "task.updated"; task: Task }
  | { type: "stage.assign"; taskId: string; stage: StageName; value: StagePayload; peerId?: string }
  | { type: "signal"; from: string; data: unknown }
  | { type: "devices"; devices: Device[] }
  | { type: "error"; message: string };

export const DeviceRole = z.enum(["worker", "admin"]);
export type DeviceRole = z.infer<typeof DeviceRole>;

export interface Device {
  deviceId: string;
  name: string;
  deviceRole: DeviceRole;
  stageNames: StageName[];
  connectedAt: string;
  lastSeenAt: string;
}

export { StagePayloadFactory } from "./stage_payload_factory.js";
