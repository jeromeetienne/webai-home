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

const Identifier = z.string().min(1).max(200);
export const RequestId = Identifier;
export const AssignmentId = Identifier;
const StagePayloadSchema = z.union([
  z.number().finite(),
  z.object({
    tensors: z.record(z.string().max(500), z.object({ dims: z.array(z.number().int()).max(8), type: z.string().max(100), dataBase64: z.string().max(8_000_000) })).optional(),
    text: z.string().max(100_000).optional(),
    inputIds: z.array(z.number().int()).max(100_000).optional(),
    position: z.number().int().nonnegative().optional(),
    done: z.boolean().optional(),
  }).strict(),
]) as unknown as z.ZodType<StagePayload>;

export interface StageResult {
  name: StageName;
  value: StagePayload;
}
export interface Task {
  taskId: string;
  requestId: string;
  consumerDeviceId: string;
  input: TaskInput;
  state: TaskState;
  completedStages: StageResult[];
  result?: StagePayload;
  error?: string;
  createdAt: string;
  updatedAt: string;
  assignment?: StageAssignment | undefined;
  assignmentAttempts: StageAssignment[];
  events: TaskEvent[];
  submissionDeadlineAt: string;
  /** Monotonic task-state revision. Clients ignore older snapshots and resynchronise after gaps. */
  revision: number;
  /** Pipeline identity is optional while the built-in formula and LLM pipelines are migrated. */
  pipelineId?: string;
  pipelineVersion?: number;
}

/** The worker-specific identity of the stage that may currently update a task. */
export interface StageAssignment {
  workerDeviceId: string;
  assignmentId: string;
  attempt: number;
  stage: StageName;
  value: StagePayload;
  leaseUntil: string;
  acceptedAt?: string | undefined;
  retryReason?: AssignmentRetryReason | undefined;
}

export const AssignmentRetryReason = z.enum(["lease_expired", "worker_disconnected", "worker_relinquished"]);
export type AssignmentRetryReason = z.infer<typeof AssignmentRetryReason>;
export interface TaskEvent {
  type: "assignment_created" | "assignment_accepted" | "assignment_retried" | "task_cancelled";
  timestamp: string;
  reason?: string | undefined;
  assignmentId?: string | undefined;
  attempt?: number | undefined;
}

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("observe") }).strict(),
  z.object({ type: z.literal("task.observe"), taskId: Identifier }).strict(),
  z.object({ type: z.literal("task.unobserve"), taskId: Identifier }).strict(),
  z.object({ type: z.literal("task.resync"), taskId: Identifier }).strict(),
  z.object({ type: z.literal("devices.resync") }).strict(),
  z.object({ type: z.literal("register"), role: z.enum(["worker", "consumer"]), name: z.string().min(1).max(200), stageNames: z.array(StageName).max(10).optional(), ready: z.boolean().optional(), maxConcurrentAssignments: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ type: z.literal("task.submit"), requestId: RequestId, input: TaskInput }).strict(),
  z.object({ type: z.literal("task.get"), taskId: Identifier }).strict(),
  z.object({ type: z.literal("stage.result"), taskId: Identifier, assignmentId: AssignmentId, attempt: z.number().int().positive(), stage: StageName, value: StagePayloadSchema }).strict(),
  z.object({ type: z.literal("stage.failed"), taskId: Identifier, assignmentId: AssignmentId, attempt: z.number().int().positive(), stage: StageName, error: z.string().min(1).max(10_000) }).strict(),
	 z.object({ type: z.literal("stage.accepted"), taskId: Identifier, assignmentId: AssignmentId, attempt: z.number().int().positive() }).strict(),
	 z.object({ type: z.literal("stage.relinquish"), taskId: Identifier, assignmentId: AssignmentId, attempt: z.number().int().positive() }).strict(),
	 z.object({ type: z.literal("task.cancel"), taskId: Identifier, reason: z.string().min(1).max(10_000) }).strict(),
	 z.object({ type: z.literal("worker.state"), state: z.enum(["ready", "draining"]), maxConcurrentAssignments: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ type: z.literal("signal"), to: Identifier, data: z.unknown() }).strict(),
  z.object({ type: z.literal("log.entry"), direction: z.enum(["received", "sent"]), messageType: z.string().min(1).max(200), timestamp: z.string().datetime(), payload: z.unknown() }).strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ProtocolErrorCode = z.enum([
  "INVALID_MESSAGE", "NOT_REGISTERED", "VALIDATION", "AUTHORISATION", "TASK_NOT_FOUND", "REQUEST_ID_CONFLICT",
  "ASSIGNMENT_OWNER_MISMATCH", "STALE_ASSIGNMENT", "CAPACITY_EXHAUSTED", "CANCELLED", "DEADLINE_EXPIRED",
  "WORKER_REQUIRED", "CONSUMER_REQUIRED", "TASK_OWNER_MISMATCH", "ASSIGNMENT_STAGE_MISMATCH", "ASSIGNMENT_NOT_ACCEPTED",
  "MESSAGE_TOO_LARGE", "UNSUPPORTED", "NO_COMPATIBLE_WORKER", "AUTHENTICATION_REQUIRED", "RATE_LIMITED",
]);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCode>;
export interface ProtocolError {
  type: "error";
  code: ProtocolErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
  taskId?: string;
  /** Whether retrying unchanged input may succeed. */
  retryable?: boolean;
}

export type GatewayMessage =
  | { type: "registered"; deviceId: string }
  | { type: "task.accepted"; requestId: string; task: Task }
  | { type: "task.updated"; task: Task }
  | { type: "stage.assign"; taskId: string; assignmentId: string; attempt: number; stage: StageName; value: StagePayload; leaseUntil: string; peerId?: string }
  | { type: "stage.cancel"; taskId: string; assignmentId: string; attempt: number; reason: string }
  | { type: "signal"; from: string; data: unknown }
  | { type: "devices"; devices: Device[]; revision: number }
  | { type: "device.joined" | "device.updated"; device: Device; revision: number }
  | { type: "device.left"; deviceId: string; revision: number }
  | ProtocolError;

export const DeviceRole = z.enum(["worker", "consumer"]);
export type DeviceRole = z.infer<typeof DeviceRole>;

export interface Device {
  deviceId: string;
  name: string;
  deviceRole: DeviceRole;
  stageNames: StageName[];
  connectedAt: string;
  lastSeenAt: string;
  workerState?: "ready" | "draining" | undefined;
  ready?: boolean;
  maxConcurrentAssignments?: number;
  activeAssignments?: number;
  membershipRevision?: number;
}

export { StagePayloadFactory } from "./stage_payload_factory.js";
