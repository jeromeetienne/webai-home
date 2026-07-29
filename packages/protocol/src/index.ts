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

export const PipelineStageSchema = z.object({
  name: StageName,
  inputSchemaId: z.string().min(1).max(200),
  outputSchemaId: z.string().min(1).max(200),
  encoding: z.enum(["inline-json"]),
}).strict();
export const PipelineSpecificationSchema = z.object({
  pipelineId: z.string().min(1).max(200),
  version: z.number().int().positive(),
  taskType: TaskType,
  stages: z.array(PipelineStageSchema).min(1).max(20),
  retired: z.boolean().optional(),
}).strict().superRefine((specification, context) => {
  const names = specification.stages.map((stage) => stage.name);
  if (new Set(names).size !== names.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "A pipeline may not contain a stage more than once" });
});
export type PipelineSpecification = z.infer<typeof PipelineSpecificationSchema>;

/**
 * A named tensor carried inside a stage payload, encoded as text so it can travel
 * inside a JSON message. This is the probe encoding for the step-0 de-risking test
 * in https://github.com/webai-at-home/webai-at-home/issues/9 — not a final format.
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
  consumerPrincipal?: string;
  input: TaskInput;
  state: TaskState;
  completedStages: StageResult[];
  result?: StagePayload;
  error?: string;
  createdAt: string;
  updatedAt: string;
  assignment?: StageAssignment | undefined;
  assignmentAttempts: StageAssignment[];
  /** Number of assignments attempted for the stage that is currently pending. */
  currentStageAttempts: number;
  events: TaskEvent[];
  submissionDeadlineAt: string;
  /** Monotonic task-state revision. Clients ignore older snapshots and resynchronise after gaps. */
  revision: number;
  /** Pipeline identity is optional while the built-in formula and LLM pipelines are migrated. */
  pipelineId?: string;
  pipelineVersion?: number;
  pipelineStages?: StageName[];
  acknowledgedAssignmentIds?: string[];
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

/** How many of the most recent task events a `TaskSnapshot` carries. The full change log is available through the `task.history` message. */
export const maximumSnapshotEventCount = 20;

/**
 * The identity of the assignment a task is currently working on, without the stage input
 * value. The assigned worker already received that value in its own `stage.assign`
 * message, and no other recipient of a task update needs it.
 */
export type TaskUpdateAssignment = Omit<StageAssignment, "value">;

/**
 * The full current state of one task, as sent when a client asks for a task.
 *
 * This is the authoritative representation of a task. `recentEvents` is a diagnostic
 * change log of the same facts and is never the source of truth; it is truncated to the
 * most recent `maximumSnapshotEventCount` entries.
 *
 * The per-attempt assignment history is deliberately absent. The gateway keeps that
 * history internally to make retry decisions, but it is not part of the protocol,
 * because every attempt carries a full stage input value and the list only ever grows.
 */
export type TaskSnapshot = Omit<Task, "assignmentAttempts" | "events" | "assignment"> & {
  assignment?: TaskUpdateAssignment | undefined;
  recentEvents: TaskEvent[];
};

/**
 * The slim task projection sent on every task revision.
 *
 * It carries only what changes as a task advances, so its size does not grow with the
 * number of stages a task runs. No stage input value appears in it at all, and no value
 * appears twice. The single exception is `result`, which is present only in the final
 * revision of a completed task and is the output the consumer asked for.
 *
 * A client that needs the task input, the completed stage values, or the change log asks
 * for them with `task.get`, `task.resync`, or `task.history`.
 */
export interface TaskUpdate {
  taskId: string;
  revision: number;
  state: TaskState;
  updatedAt: string;
  /** How many stages have completed. This doubles as the index of the stage now running. */
  completedStageCount: number;
  /** The stage the task is currently working on, when a stage is assigned. */
  currentStage?: StageName | undefined;
  /** How many assignments have been attempted for the stage that is currently pending. */
  currentStageAttempts: number;
  assignment?: TaskUpdateAssignment | undefined;
  /** The task output. Present only when the task reached the `completed` state. */
  result?: StagePayload | undefined;
  error?: string | undefined;
}

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("observe") }).strict(),
  z.object({ type: z.literal("authenticate"), token: z.string().min(1).max(4_000) }).strict(),
  z.object({ type: z.literal("task.observe"), taskId: Identifier }).strict(),
  z.object({ type: z.literal("task.unobserve"), taskId: Identifier }).strict(),
  z.object({ type: z.literal("task.resync"), taskId: Identifier }).strict(),
  z.object({ type: z.literal("task.observer.grant"), taskId: Identifier, consumerDeviceId: Identifier }).strict(),
  z.object({ type: z.literal("task.observer.revoke"), taskId: Identifier, consumerDeviceId: Identifier }).strict(),
  z.object({ type: z.literal("devices.resync") }).strict(),
  z.object({ type: z.literal("devices.subscribe") }).strict(),
  z.object({ type: z.literal("devices.unsubscribe") }).strict(),
  z.object({ type: z.literal("register"), role: z.enum(["worker", "consumer"]), name: z.string().min(1).max(200), stageNames: z.array(StageName).max(10).optional(), ready: z.boolean().optional(), maxConcurrentAssignments: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ type: z.literal("task.submit"), requestId: RequestId, input: TaskInput, pipelineId: Identifier.optional(), pipelineVersion: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal("task.get"), taskId: Identifier }).strict(),
  z.object({ type: z.literal("task.history"), taskId: Identifier }).strict(),
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
  | { type: "authenticated"; principal: string; expiresAt: string }
  | { type: "registered"; deviceId: string }
  | { type: "task.accepted"; requestId: string; task: TaskSnapshot }
  | { type: "task.snapshot"; task: TaskSnapshot }
  | { type: "task.updated"; update: TaskUpdate }
  | { type: "task.history"; taskId: string; events: TaskEvent[] }
  | { type: "stage.assign"; taskId: string; assignmentId: string; attempt: number; stage: StageName; value: StagePayload; leaseUntil: string; peerId?: string }
  | { type: "stage.cancel"; taskId: string; assignmentId: string; attempt: number; reason: string }
  | { type: "stage.result.accepted"; taskId: string; assignmentId: string; attempt: number; revision: number; status: "assigned" | "completed" | "failed" }
  | { type: "signal"; from: string; data: unknown }
  | { type: "devices"; devices: Device[]; revision: number }
  | { type: "device.joined" | "device.updated"; device: Device; revision: number }
  | { type: "device.activity"; devices: DeviceActivity[]; revision: number }
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
  principal?: string;
  ready?: boolean;
  maxConcurrentAssignments?: number;
  activeAssignments?: number;
  membershipRevision?: number;
}

/**
 * The device fields that change as work is assigned to a device and returned by it, as
 * opposed to the fields that describe the device itself.
 *
 * These fields change far more often than the rest of a device record: a worker's
 * `activeAssignments` count moves up when a stage is assigned and down when the result
 * arrives, twice per stage. They are sent on their own, in `device.activity`, so a
 * counter moving from 0 to 1 does not re-transmit the device's name and stage list.
 */
export interface DeviceActivity {
  deviceId: string;
  lastSeenAt: string;
  workerState?: "ready" | "draining" | undefined;
  ready?: boolean | undefined;
  activeAssignments?: number | undefined;
}

/** The device fields carried by `DeviceActivity`, in the order a device record declares them. */
export const deviceActivityFieldNames = ["lastSeenAt", "workerState", "ready", "activeAssignments"] as const;

export { StagePayloadFactory } from "./stage_payload_factory.js";
