import { z } from 'zod';
import type { Device, DeviceActivity } from '../device_types.js';
import type { StagePayload } from '../stage/stage_payload_types.js';
import type { PipelineSpecification, StageName } from '../task/pipeline_types.js';
import type { GenerationSettings, TaskEvent, TaskSnapshot, TaskUpdate } from '../task/task_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewayMessage — every message the gateway may send a client, and the errors it answers with
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The stable codes an error message may carry. */
export const ProtocolErrorCode = z.enum([
	'INVALID_MESSAGE', 'NOT_REGISTERED', 'VALIDATION', 'AUTHORISATION', 'TASK_NOT_FOUND', 'TASK_REQUEST_ID_CONFLICT',
	'ASSIGNMENT_OWNER_MISMATCH', 'STALE_ASSIGNMENT', 'CAPACITY_EXHAUSTED', 'CANCELLED', 'DEADLINE_EXPIRED',
	'WORKER_REQUIRED', 'CONSUMER_REQUIRED', 'TASK_OWNER_MISMATCH', 'ASSIGNMENT_STAGE_MISMATCH', 'ASSIGNMENT_NOT_ACCEPTED',
	'MESSAGE_TOO_LARGE', 'UNSUPPORTED', 'NO_COMPATIBLE_WORKER', 'AUTHENTICATION_REQUIRED', 'RATE_LIMITED',
]);
/** The stable codes an error message may carry. */
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCode>;

/** An error the gateway sends in answer to something a client sent. */
export type ProtocolError = {
	type: 'error';
	code: ProtocolErrorCode;
	message: string;
	details?: Record<string, unknown>;
	taskRequestId?: string;
	taskId?: string;
	/** Whether retrying unchanged input may succeed. */
	retryable?: boolean;
};

/** Every message the gateway may send a client, told apart by its `type`. */
export type GatewayMessage =
	| { type: 'deviceAuthenticated'; authIdentity: string; expiresAt: string }
	| { type: 'deviceRegistered'; deviceId: string }
	| { type: 'task.accepted'; taskRequestId: string; task: TaskSnapshot }
	| { type: 'task.snapshot'; task: TaskSnapshot }
	| { type: 'task.updated'; update: TaskUpdate }
	| { type: 'task.history'; taskId: string; events: TaskEvent[] }
	// "pipelines" answers "pipelines.get". A worker asks for it before it registers, so it can
	// advertise every stage whose computation it implements, including stages of a pipeline
	// that was added after the worker was built.
	| { type: 'pipelines'; pipelines: PipelineSpecification[] }
	// "stage.assign" carries "computation" so the worker knows what code to run without
	// recognising the stage name, "stageIndex" so a computation with ordered parts, such
	// as a language-model shard, knows which part of its pipeline it is running, and
	// "generationSettings" so it knows what the consumer asked for about how the answer is
	// generated. All three ride on the assignment message rather than in "value", because
	// "value" is what a stage consumes and returns — a plain number for the formula pipeline —
	// and is stored again with every completed stage and every assignment attempt.
	| { type: 'stage.assign'; taskId: string; stageAssignmentId: string; attempt: number; stage: StageName; computation: string; stageIndex: number; value: StagePayload; generationSettings?: GenerationSettings | undefined; leaseUntil: string; peerId?: string }
	| { type: 'stage.cancel'; taskId: string; stageAssignmentId: string; attempt: number; reason: string }
	| { type: 'stage.lease.extended'; taskId: string; stageAssignmentId: string; attempt: number; leaseUntil: string }
	| { type: 'stage.result.accepted'; taskId: string; stageAssignmentId: string; attempt: number; taskRevision: number; status: 'assigned' | 'completed' | 'failed' }
	| { type: 'signal'; from: string; data: unknown }
	| { type: 'devices'; devices: Device[]; deviceListRevision: number }
	| { type: 'device.joined' | 'device.updated'; device: Device; deviceListRevision: number }
	| { type: 'device.activity'; devices: DeviceActivity[]; deviceListRevision: number }
	| { type: 'device.left'; deviceId: string; deviceListRevision: number }
	| ProtocolError;
