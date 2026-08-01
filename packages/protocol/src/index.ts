import { z } from 'zod';

/** Every state a task may be in, from submission to a terminal state. */
export const TaskState = z.enum(['queued', 'assigned', 'running', 'completed', 'failed', 'cancelled']);
/** Every state a task may be in, from submission to a terminal state. */
export type TaskState = z.infer<typeof TaskState>;

/**
 * The name of one stage of one pipeline.
 *
 * This is a bounded, pattern-checked string rather than a list of the stage names that
 * happen to exist today. Which stage names actually exist is decided at run time by the
 * pipeline specifications the gateway has loaded, so a new pipeline can be added through the
 * gateway's `--pipeline-file` option without changing this shared package and without
 * rebuilding the gateway, the worker, and the consumer together.
 *
 * A worker that advertises a stage no loaded pipeline defines is refused at registration, so
 * a mistyped name is still reported rather than silently never receiving work.
 */
export const StageName = z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/, 'A stage name must start with a lower-case letter and contain only lower-case letters, digits, and underscores');
/** The name of one step of one pipeline. */
export type StageName = z.infer<typeof StageName>;

/** The kinds of work a consumer may submit. */
export const TaskType = z.enum([
	'task_type_dev_formula',
	'task_type_llm_qwen3_0_6b_sharded',
	'task_type_llm_gemma_nano_chrome_full',
	'task_type_llm_qwen3_5_0_8b_full',
	'task_type_llm_llama3_2_3b_full',
]);
/** The kinds of work a consumer may submit. */
export type TaskType = z.infer<typeof TaskType>;

/**
 * What a consumer asks for about how its answer is generated, rather than what the answer is
 * about.
 *
 * These settings are stated once, when the task is submitted, and the gateway carries them
 * unchanged to the worker on every `stage.assign` of that task. The gateway does not read
 * them: which of them a stage honours is decided by the code that runs the stage, because a
 * setting means different things to a stage that drives a browser's built-in model and to a
 * stage that runs one shard of a model this project ships.
 *
 * The object refuses a field it does not recognise, rather than dropping it. A setting that is
 * silently dropped changes the answer a consumer receives without telling it anything went
 * wrong, so a consumer that asks for a setting this protocol version does not define has its
 * submission refused and can decide for itself whether to submit again without it.
 *
 * That holds only where both sides know this block exists. A gateway built before it did has
 * no `generationSettings` field on its task input at all, and its task input members are not
 * strict, so it drops the whole block silently and answers as though nothing had been asked
 * for. Nothing catches that today, because no stage yet honours a setting and so no answer yet
 * differs; the moment one does, the protocol version is what has to say so.
 */
export const GenerationSettingsSchema = z.object({
	/**
	 * Whether the consumer wants the answer in pieces as it is produced, rather than in one
	 * result once it is finished.
	 *
	 * Asking for pieces costs a scheduling round for every piece, so it is a per-task choice
	 * rather than how the cluster always behaves. A task that does not ask for it is answered
	 * with the fewest messages the pipeline can manage.
	 */
	isStreaming: z.boolean().optional(),
}).strict();
/** What a consumer asks for about how its answer is generated. */
export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;

/** The work submitted with a task: its kind, the value that kind carries, and how to generate it. */
export const TaskInput = z.discriminatedUnion('taskType', [
	z.object({ taskType: z.literal('task_type_dev_formula'), input: z.number().finite(), generationSettings: GenerationSettingsSchema.optional() }),
	z.object({ taskType: z.literal('task_type_llm_qwen3_0_6b_sharded'), input: z.string(), generationSettings: GenerationSettingsSchema.optional() }),
	z.object({ taskType: z.literal('task_type_llm_gemma_nano_chrome_full'), input: z.string(), generationSettings: GenerationSettingsSchema.optional() }),
	z.object({ taskType: z.literal('task_type_llm_qwen3_5_0_8b_full'), input: z.string(), generationSettings: GenerationSettingsSchema.optional() }),
	z.object({ taskType: z.literal('task_type_llm_llama3_2_3b_full'), input: z.string(), generationSettings: GenerationSettingsSchema.optional() }),
]);
/** The work submitted with a task: its kind, the value that kind carries, and how to generate it. */
export type TaskInput = z.infer<typeof TaskInput>;

/** One step of a pipeline: what it computes, what it accepts and returns, and how it is placed. */
export const PipelineStageSchema = z.object({
	name: StageName,
	/**
	 * Which computation a worker must run for this stage, such as `dev_formula_multiply` or
	 * `llm_qwen3_0_6b_shard`.
	 *
	 * The stage name identifies a step of one pipeline; the computation identifies the code
	 * that carries the step out. Separating the two is what lets a new pipeline reuse a
	 * computation a worker already ships, under a stage name that appears nowhere in the
	 * source. Every `stage.assign` carries this value, so a worker never has to recognise a
	 * stage name to know what to run.
	 */
	computation: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/, 'A computation name must start with a lower-case letter and contain only lower-case letters, digits, and underscores'),
	inputSchemaId: z.string().min(1).max(200),
	outputSchemaId: z.string().min(1).max(200),
	encoding: z.enum(['inline-json']),
	/**
	 * How long the assignment lease for this stage lasts, in milliseconds. A stage that does
	 * not state one uses the gateway's `--lease-ms` default. A worker extends the lease while
	 * it is still working by sending `stage.heartbeat`.
	 */
	leaseMs: z.number().int().positive().max(3_600_000).optional(),
	/**
	 * Whether a retry of this stage should go back to the worker that previously held it,
	 * rather than deliberately avoiding that worker. Set this for a stage that keeps state
	 * between assignments, such as a language-model shard holding a key-value cache, where
	 * moving the work to a different device throws that state away.
	 */
	prefersSameWorkerOnRetry: z.boolean().optional(),
}).strict();
/** One stage of one pipeline, as stated by its pipeline specification. */
export type PipelineStage = z.infer<typeof PipelineStageSchema>;
/** A whole pipeline: which task kind it serves, and the ordered stages it runs. */
export const PipelineSpecificationSchema = z.object({
	pipelineId: z.string().min(1).max(200),
	version: z.number().int().positive(),
	taskType: TaskType,
	stages: z.array(PipelineStageSchema).min(1).max(20),
	/**
	 * Whether the pipeline runs its stages again from the first once the last stage finishes,
	 * instead of ending there.
	 *
	 * The language-model pipeline works this way: its shards run once per generated token, and
	 * generation ends when the last stage returns a result reporting `done: true`. A pipeline
	 * that does not state this runs each of its stages exactly once.
	 */
	repeatsUntilDone: z.boolean().optional(),
	retired: z.boolean().optional(),
}).strict().superRefine((specification, context) => {
	const names = specification.stages.map((stage) => stage.name);
	if (new Set(names).size !== names.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'A pipeline may not contain a stage more than once' });
});
/** A whole pipeline: which task kind it serves, and the ordered stages it runs. */
export type PipelineSpecification = z.infer<typeof PipelineSpecificationSchema>;

/**
 * A named tensor carried inside a stage payload, encoded as text so it can travel
 * inside a JSON message. This is the probe encoding for the step-0 de-risking test
 * in https://github.com/webai-at-home/webai-at-home/issues/9 — not a final format.
 */
export type EncodedTensor = {
	dims: number[];
	type: string;
	dataBase64: string;
};

/**
 * The payload handed between LLM shard stages: the shard's hand-off tensors, and
 * (on the final shard) the generated text.
 */
export type LlmStagePayload = {
	tensors?: Record<string, EncodedTensor>;
	/**
	 * A whole piece of text, rather than a part of one: the prompt on the value handed to a
	 * task's first stage, and the complete answer on the result that finishes the task.
	 *
	 * A result that leaves the generation unfinished never carries this. Such a result carries
	 * `newText` instead, which is only what that one run produced. That is what keeps the
	 * bytes on the connection from growing with the square of the number of tokens generated:
	 * an answer that is re-sent in full once per token is sent once for every token that
	 * precedes it.
	 */
	text?: string;
	/**
	 * The text this one stage run produced, beyond everything the runs before it produced.
	 *
	 * A run that produced nothing new leaves it out rather than stating it as empty, and the run
	 * that finds a generation already finished produces nothing new by definition. So a consumer
	 * joining these in order receives every piece exactly once, but must not wait for one on the
	 * result that finishes the task: that result carries the whole answer in `text` instead, and
	 * carries a piece only when the run that ended the generation also added to it.
	 */
	newText?: string;
	/** Token identifiers for the sequence positions covered by this stage payload's tensors. */
	inputIds?: number[];
	/** Position of the first token in `inputIds` within the full generated sequence. */
	position?: number;
	/**
	 * Set on a payload that continues a generation already under way in the memory of the
	 * device that produced the previous result, instead of starting a new one.
	 *
	 * The Chrome built-in language-model task needs this. Nothing else tells the two apart:
	 * the stage is a single stage that runs again and again, so a run that starts an answer and
	 * a run that carries one on receive the same stage under a different assignment. A worker
	 * that receives a continuation and holds no generation for the task refuses the stage,
	 * rather than starting a second answer to a prompt it no longer has.
	 */
	isContinuation?: boolean;
	/** Set by the final shard once generation should stop (end-of-sequence token or the token limit reached). */
	done?: boolean;
};

/** The value carried by one stage: a plain number for the formula pipeline, or an LLM payload. */
export type StagePayload = number | LlmStagePayload;

const Identifier = z.string().min(1).max(200);
/** The identifier a consumer gives its own submission, so a repeat submission is recognised. */
export const RequestId = Identifier;
/** The identifier of one stage assignment, which outlives the attempt that carries it. */
export const AssignmentId = Identifier;
const StagePayloadSchema = z.union([
	z.number().finite(),
	z.object({
		tensors: z.record(z.string().max(500), z.object({ dims: z.array(z.number().int()).max(8), type: z.string().max(100), dataBase64: z.string().max(8_000_000) })).optional(),
		text: z.string().max(100_000).optional(),
		newText: z.string().max(100_000).optional(),
		inputIds: z.array(z.number().int()).max(100_000).optional(),
		position: z.number().int().nonnegative().optional(),
		isContinuation: z.boolean().optional(),
		done: z.boolean().optional(),
	}).strict(),
]) as unknown as z.ZodType<StagePayload>;

/** One completed stage: which stage it was, and the value it produced. */
export type StageResult = {
	name: StageName;
	value: StagePayload;
};
/** The complete state of one task, as the gateway holds it. */
export type Task = {
	taskId: string;
	requestId: string;
	consumerDeviceId: string;
	consumerPrincipal?: string;
	input: TaskInput;
	state: TaskState;
	completedStages: StageResult[];
	/**
	 * The text produced by the revision this record is currently at, and by no earlier one.
	 *
	 * Unlike every other field here, this describes one revision rather than the task, so it is
	 * dropped by the next revision that does not set it again. It is filled only for a task
	 * that asked for its answer in pieces.
	 */
	newText?: string | undefined;
	/**
	 * Everything the task's answer has produced so far.
	 *
	 * Filled only for a task that asked for its answer in pieces. It is how anyone reading the
	 * whole task can see an answer part-way through, rather than having to have followed every
	 * revision from the start: it appears on a task snapshot, so a reader that missed the
	 * revisions carrying the pieces can read what it missed instead of losing it.
	 *
	 * The pieces are joined as they arrive, and the result that finishes the answer replaces
	 * that joining with the whole answer it carries. A piece is only the device's own account of
	 * how the answer grew, and one can restate what came before it rather than adding to it, so
	 * this is exact once the task is finished and an account of it before then.
	 *
	 * Reaching it after a dropped connection needs an observer grant made before the drop. A
	 * consumer that reconnects is issued a new device identifier and is a stranger to its own
	 * task, which is a limitation of the protocol rather than of this field.
	 */
	generatedText?: string;
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
	/**
	 * The pipeline this task runs. Every task selects one when it is submitted, so the stage
	 * sequence is data the task carries rather than a sequence built into the gateway. The
	 * fields stay optional so a task stored by an earlier gateway can still be read back.
	 */
	pipelineId?: string;
	pipelineVersion?: number;
	pipelineStages?: StageName[];
	/**
	 * Whether this task's pipeline runs its stages again from the first once the last stage
	 * finishes, until a stage result reports `done: true`. Copied from the pipeline
	 * specification when the task is created, so advancing a task needs no registry lookup.
	 */
	pipelineRepeatsUntilDone?: boolean;
	/**
	 * Which worker device most recently completed each stage of this task, by stage name.
	 *
	 * A stage that keeps state in the memory of the device running it has to be placed back on
	 * the device that holds that state. Which device that is depends on which stage comes next,
	 * not on which device ran last: in a pipeline that repeats, the device that holds the state
	 * for the upcoming stage is the device that ran that same stage in the previous round.
	 *
	 * The field stays optional so a task stored by an earlier gateway can still be read back.
	 */
	stageWorkerDeviceIds?: Record<StageName, string>;
	acknowledgedAssignmentIds?: string[];
};

/** The worker-specific identity of the stage that may currently update a task. */
export type StageAssignment = {
	workerDeviceId: string;
	assignmentId: string;
	attempt: number;
	stage: StageName;
	value: StagePayload;
	leaseUntil: string;
	acceptedAt?: string | undefined;
	retryReason?: AssignmentRetryReason | undefined;
};

/** Why an assignment was replaced by a later one. */
export const AssignmentRetryReason = z.enum(['lease_expired', 'worker_disconnected', 'worker_relinquished']);
/** Why an assignment was replaced by a later one. */
export type AssignmentRetryReason = z.infer<typeof AssignmentRetryReason>;
/** One entry in a task's change log. */
export type TaskEvent = {
	type: 'assignment_created' | 'assignment_accepted' | 'assignment_retried' | 'task_cancelled';
	timestamp: string;
	reason?: string | undefined;
	assignmentId?: string | undefined;
	attempt?: number | undefined;
};

/** How many of the most recent task events a `TaskSnapshot` carries. The full change log is available through the `task.history` message. */
export const maximumSnapshotEventCount = 20;

/**
 * The identity of the assignment a task is currently working on, without the stage input
 * value. The assigned worker already received that value in its own `stage.assign`
 * message, and no other recipient of a task update needs it.
 */
export type TaskUpdateAssignment = Omit<StageAssignment, 'value'>;

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
export type TaskSnapshot = Omit<Task, 'assignmentAttempts' | 'events' | 'assignment' | 'newText'> & {
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
export type TaskUpdate = {
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
	/**
	 * The text produced since the previous revision of this task.
	 *
	 * Present only on a task that asked for its answer in pieces, through the `isStreaming`
	 * generation setting, and only on a revision that produced text. Joining these in revision
	 * order gives the whole answer, so a consumer can show an answer as it is written instead
	 * of waiting for `result`.
	 *
	 * It is the piece and never the answer so far, so a task update does not grow as the answer
	 * does. A consumer that wants the answer as one piece of text ignores this and reads
	 * `result` when the task completes.
	 */
	newText?: string | undefined;
	/** The task output. Present only when the task reached the `completed` state. */
	result?: StagePayload | undefined;
	error?: string | undefined;
};

/** Every message a client may send the gateway, told apart by its `type`. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('observe') }).strict(),
	z.object({ type: z.literal('authenticate'), token: z.string().min(1).max(4_000) }).strict(),
	z.object({ type: z.literal('task.observe'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('task.unobserve'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('task.resync'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('task.observer.grant'), taskId: Identifier, consumerDeviceId: Identifier }).strict(),
	z.object({ type: z.literal('task.observer.revoke'), taskId: Identifier, consumerDeviceId: Identifier }).strict(),
	z.object({ type: z.literal('devices.resync') }).strict(),
	z.object({ type: z.literal('devices.subscribe') }).strict(),
	z.object({ type: z.literal('devices.unsubscribe') }).strict(),
	z.object({ type: z.literal('register'), role: z.enum(['worker', 'consumer']), name: z.string().min(1).max(200), stageNames: z.array(StageName).max(10).optional(), ready: z.boolean().optional(), maxConcurrentAssignments: z.number().int().min(1).max(100).optional() }).strict(),
	z.object({ type: z.literal('task.submit'), requestId: RequestId, input: TaskInput, pipelineId: Identifier.optional(), pipelineVersion: z.number().int().positive().optional() }).strict(),
	z.object({ type: z.literal('pipelines.get') }).strict(),
	z.object({ type: z.literal('task.get'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('task.history'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('stage.result'), taskId: Identifier, assignmentId: AssignmentId, attempt: z.number().int().positive(), stage: StageName, value: StagePayloadSchema }).strict(),
	z.object({ type: z.literal('stage.failed'), taskId: Identifier, assignmentId: AssignmentId, attempt: z.number().int().positive(), stage: StageName, error: z.string().min(1).max(10_000) }).strict(),
	 z.object({ type: z.literal('stage.accepted'), taskId: Identifier, assignmentId: AssignmentId, attempt: z.number().int().positive() }).strict(),
	 z.object({ type: z.literal('stage.relinquish'), taskId: Identifier, assignmentId: AssignmentId, attempt: z.number().int().positive() }).strict(),
	 z.object({ type: z.literal('stage.heartbeat'), taskId: Identifier, assignmentId: AssignmentId, attempt: z.number().int().positive() }).strict(),
	 z.object({ type: z.literal('task.cancel'), taskId: Identifier, reason: z.string().min(1).max(10_000) }).strict(),
	 z.object({ type: z.literal('worker.state'), state: z.enum(['ready', 'draining']), maxConcurrentAssignments: z.number().int().min(1).max(100).optional() }).strict(),
	z.object({ type: z.literal('signal'), to: Identifier, data: z.unknown() }).strict(),
]);
/** Every message a client may send the gateway, told apart by its `type`. */
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Diagnostics
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One message a worker browser page saw, as that page reports it to the gateway.
 *
 * A browser page cannot write its own log file, so it tells the gateway which messages it
 * saw and when, and the gateway appends them to that worker's log file on its behalf.
 *
 * This carries no message body. The gateway is one end of every connection the worker has,
 * so it has already recorded the body of every message named here. The only fact the worker
 * adds is its own view of the timing, and `messageId` joins each entry to the gateway's own
 * record of the same message, which does carry the body.
 */
export const DiagnosticEntrySchema = z.object({
	/** Whether the worker received this message from, or sent it to, the gateway. */
	direction: z.enum(['received', 'sent']),
	/** The message's `type` field, such as "stage.assign". */
	messageType: z.string().min(1).max(200),
	/** When the worker saw the message, by the browser's own clock. */
	timestamp: z.string().datetime(),
	/** The identifier of the frame the message travelled in, for joining to the gateway's own record. */
	messageId: Identifier.optional(),
}).strict();
/** One message a worker browser page saw, as that page reports it to the gateway. */
export type DiagnosticEntry = z.infer<typeof DiagnosticEntrySchema>;

/** The largest number of entries one diagnostics report may carry. */
export const maximumDiagnosticEntriesPerBatch = 200;

/**
 * A batch of diagnostic entries, as posted to the gateway's diagnostics endpoint.
 *
 * Diagnostics travel over HTTP rather than over the WebSocket connection that carries
 * scheduling, so that reporting cannot compete with stage assignment and result collection
 * (see https://github.com/webai-at-home/webai-at-home/issues/50).
 */
export const DiagnosticsBatchSchema = z.object({
	/** The device identifier the gateway issued this worker when it registered. */
	deviceId: Identifier,
	/** The messages this worker saw since its last report. */
	entries: z.array(DiagnosticEntrySchema).min(1).max(maximumDiagnosticEntriesPerBatch),
}).strict();
/** A batch of diagnostic entries, as posted to the gateway's diagnostics endpoint. */
export type DiagnosticsBatch = z.infer<typeof DiagnosticsBatchSchema>;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Envelope
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The version of this protocol that these programs speak.
 *
 * Every frame states the version it was written for, and the gateway refuses a version it
 * does not support at the moment a connection authenticates. A peer therefore learns
 * straight away whether it can talk to the other side, instead of discovering it through a
 * validation failure on some later message.
 *
 * Version 2 changed what a language-model stage result carries while a generation is still
 * running: the text produced by that one run, in `newText`, where version 1 carried the whole
 * answer so far in `text`. A gateway of version 1 does not accept a version 2 frame, so a
 * worker built after the change is refused by a gateway built before it at the moment it
 * authenticates, rather than having its first result refused for a shape that gateway's stage
 * payload schema does not allow.
 */
export const protocolVersion = 2;

/**
 * The protocol versions the gateway accepts.
 *
 * Version 1 is still accepted. A version 1 worker returns the whole answer so far in `text`
 * on every result rather than the piece in `newText`, so a task it runs completes with the
 * right answer and simply reports no pieces along the way. The consumer of such a task sees
 * an answer that arrives all at once, which is what it would see from a task that never asked
 * for pieces.
 */
export const supportedProtocolVersions: number[] = [1, 2];

/**
 * The wrapper around every frame sent in either direction.
 *
 * Nothing in the protocol travels bare. The wrapper carries what a message needs to say
 * about itself and could not say before: which protocol version wrote it, which frame it is,
 * when it was sent, and — on an answer from the gateway — which request it answers.
 */
export const EnvelopeSchema = z.object({
	/** The protocol version this frame was written for. */
	v: z.number().int().positive(),
	/** This frame's own identifier, generated by whoever sent it. */
	id: Identifier,
	/** When this frame was sent, in ISO 8601 format. */
	ts: z.string().datetime(),
	/**
	 * The `id` of the request this frame answers.
	 *
	 * Present on every gateway answer to a client request, and absent on every unsolicited
	 * message the gateway pushes. That is the whole distinction: a push is a frame with no
	 * `inReplyTo`, rather than a message type that happens to have been chosen for pushes.
	 */
	inReplyTo: Identifier.optional(),
});

/** A frame received from a client, once its body has been validated. */
export const ClientEnvelopeSchema = EnvelopeSchema.extend({ body: ClientMessageSchema }).strict();
/** The wrapper a client message travels in. */
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;

/** A frame sent by the gateway. */
export type GatewayEnvelope = z.infer<typeof EnvelopeSchema> & { body: GatewayMessage };

/** The stable codes an error message may carry. */
export const ProtocolErrorCode = z.enum([
	'INVALID_MESSAGE', 'NOT_REGISTERED', 'VALIDATION', 'AUTHORISATION', 'TASK_NOT_FOUND', 'REQUEST_ID_CONFLICT',
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
	requestId?: string;
	taskId?: string;
	/** Whether retrying unchanged input may succeed. */
	retryable?: boolean;
};

/** Every message the gateway may send a client, told apart by its `type`. */
export type GatewayMessage =
	| { type: 'authenticated'; principal: string; expiresAt: string }
	| { type: 'registered'; deviceId: string }
	| { type: 'task.accepted'; requestId: string; task: TaskSnapshot }
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
	| { type: 'stage.assign'; taskId: string; assignmentId: string; attempt: number; stage: StageName; computation: string; stageIndex: number; value: StagePayload; generationSettings?: GenerationSettings | undefined; leaseUntil: string; peerId?: string }
	| { type: 'stage.cancel'; taskId: string; assignmentId: string; attempt: number; reason: string }
	| { type: 'stage.lease.extended'; taskId: string; assignmentId: string; attempt: number; leaseUntil: string }
	| { type: 'stage.result.accepted'; taskId: string; assignmentId: string; attempt: number; revision: number; status: 'assigned' | 'completed' | 'failed' }
	| { type: 'signal'; from: string; data: unknown }
	| { type: 'devices'; devices: Device[]; revision: number }
	| { type: 'device.joined' | 'device.updated'; device: Device; revision: number }
	| { type: 'device.activity'; devices: DeviceActivity[]; revision: number }
	| { type: 'device.left'; deviceId: string; revision: number }
	| ProtocolError;

/** What a connected device is here to do. */
export const DeviceRole = z.enum(['worker', 'consumer']);
/** What a connected device is here to do. */
export type DeviceRole = z.infer<typeof DeviceRole>;

/** One connected device, as the gateway describes it to the pages that display it. */
export type Device = {
	deviceId: string;
	name: string;
	deviceRole: DeviceRole;
	stageNames: StageName[];
	connectedAt: string;
	lastSeenAt: string;
	workerState?: 'ready' | 'draining' | undefined;
	principal?: string;
	ready?: boolean;
	maxConcurrentAssignments?: number;
	activeAssignments?: number;
	membershipRevision?: number;
};

/**
 * The device fields that change as work is assigned to a device and returned by it, as
 * opposed to the fields that describe the device itself.
 *
 * These fields change far more often than the rest of a device record: a worker's
 * `activeAssignments` count moves up when a stage is assigned and down when the result
 * arrives, twice per stage. They are sent on their own, in `device.activity`, so a
 * counter moving from 0 to 1 does not re-transmit the device's name and stage list.
 */
export type DeviceActivity = {
	deviceId: string;
	lastSeenAt: string;
	workerState?: 'ready' | 'draining' | undefined;
	ready?: boolean | undefined;
	activeAssignments?: number | undefined;
};

/** The device fields carried by `DeviceActivity`, in the order a device record declares them. */
export const deviceActivityFieldNames = ['lastSeenAt', 'workerState', 'ready', 'activeAssignments'] as const;

export { StagePayloadFactory } from './stage_payload_factory.js';
export { GeneratedText } from './generated_text.js';
