import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClientEnvelopeSchema, ClientMessageSchema, DiagnosticsBatchSchema, PipelineSpecificationSchema, PipelineStageSchema, StageName, StagePayloadFactory, TaskInput, TaskState, maximumDiagnosticEntriesPerBatch, maximumSnapshotEventCount, protocolVersion } from "../src/index.js";
import type { Task, TaskEvent } from "../src/index.js";
import { MessageLogger } from "../src/message_logger.js";
import type { LogEntry } from "../src/message_logger.js";
import { TaskProjection } from "../src/task_projection.js";
import { Envelope } from "../src/envelope.js";
import { SessionRenewal } from "../src/session_renewal.js";

test("accepts valid task input", () => {
  assert.deepEqual(TaskInput.parse({ taskType: "task_type_dev_formula", input: 12.5 }), { taskType: "task_type_dev_formula", input: 12.5 });
  assert.deepEqual(TaskInput.parse({ taskType: "task_type_llm_qwen3_0_6b_sharded", input: "hello" }), { taskType: "task_type_llm_qwen3_0_6b_sharded", input: "hello" });
  assert.deepEqual(TaskInput.parse({ taskType: "task_type_llm_gemma_nano_chrome_full", input: "hello" }), { taskType: "task_type_llm_gemma_nano_chrome_full", input: "hello" });
});

test("rejects non-finite task input", () => {
  assert.equal(TaskInput.safeParse({ taskType: "task_type_dev_formula", input: Number.NaN }).success, false);
  assert.equal(TaskInput.safeParse({ taskType: "task_type_dev_formula", input: Infinity }).success, false);
});

test("rejects task input that does not match its task type", () => {
  assert.equal(TaskInput.safeParse({ taskType: "task_type_llm_qwen3_0_6b_sharded", input: 5 }).success, false);
  assert.equal(TaskInput.safeParse({ taskType: "task_type_llm_gemma_nano_chrome_full", input: 5 }).success, false);
  assert.equal(TaskInput.safeParse({ taskType: "task_type_dev_formula", input: "5" }).success, false);
});

test("restricts task states, and checks the shape of a stage name without listing them", () => {
  assert.equal(TaskState.safeParse("completed").success, true);
  assert.equal(TaskState.safeParse("unknown").success, false);
  assert.equal(StageName.safeParse("stage_dev_formula_multiply").success, true);
  assert.equal(StageName.safeParse("stage_llm_qwen3_0_6b_shard1of3").success, true);
  // A stage name this package has never heard of is accepted, because which stage names
  // exist is decided at run time by the pipelines the gateway has loaded.
  assert.equal(StageName.safeParse("stage_invented_by_a_pipeline_file").success, true);
  // The shape is still checked, so a mistyped name is rejected rather than silently used.
  assert.equal(StageName.safeParse("Stage-Formula-Multiply").success, false);
  assert.equal(StageName.safeParse("9stage").success, false);
  assert.equal(StageName.safeParse("").success, false);
  assert.equal(StageName.safeParse("a".repeat(101)).success, false);
});

test("StagePayloadFactory builds each stage payload shape", () => {
  assert.equal(StagePayloadFactory.formula(42), 42);
  assert.deepEqual(StagePayloadFactory.llmPrompt("hello"), { text: "hello" });

  const tensors = { "/model/layers.9/input_layernorm/output_0": { dims: [1, 1, 4], type: "float16", dataBase64: "AA==" } };
  assert.deepEqual(StagePayloadFactory.llmHandoff(tensors, [1, 2, 3], 0), { tensors, inputIds: [1, 2, 3], position: 0 });

  assert.deepEqual(StagePayloadFactory.llmContinue("The", 464, 20), { text: "The", inputIds: [464], position: 20, done: false });
  assert.deepEqual(StagePayloadFactory.llmPartialText("The capital"), { text: "The capital", isContinuation: true, done: false });
  assert.deepEqual(StagePayloadFactory.llmDone("The capital of France is Paris."), { text: "The capital of France is Paris.", done: true });
});

test("StagePayloadFactory answers every task type with a first stage value", () => {
  assert.equal(StagePayloadFactory.initial({ taskType: "task_type_dev_formula", input: 5 }), 5);
  assert.deepEqual(StagePayloadFactory.initial({ taskType: "task_type_llm_qwen3_0_6b_sharded", input: "hello" }), { text: "hello" });
  assert.deepEqual(StagePayloadFactory.initial({ taskType: "task_type_llm_gemma_nano_chrome_full", input: "hello" }), { text: "hello" });
});

test("validates every inbound client message shape", () => {
  assert.equal(ClientMessageSchema.safeParse({ type: "task.submit", requestId: "request-1", input: { taskType: "task_type_dev_formula", input: 5 } }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.result", taskId: "task-1", assignmentId: "assignment-1", attempt: 1, stage: "stage_dev_formula_multiply", value: 10 }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.result", taskId: "task-1", assignmentId: "assignment-1", attempt: 1, stage: "stage_llm_gemma_nano_chrome_full", value: { text: "The capital", isContinuation: true, done: false } }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "task.submit", input: { taskType: "task_type_dev_formula", input: 5 } }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.result", taskId: "task-1", stage: "stage_dev_formula_multiply", value: 10 }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "register", role: "consumer", name: "consumer", unexpected: true }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "task.history", taskId: "task-1" }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "task.history" }).success, false);
});

test("redacts task inputs and stage values but keeps the task type", () => {
  const directoryPath = mkdtempSync(join(tmpdir(), "message-logger-"));
  const logFilePath = join(directoryPath, "log.log_entry.jsonl");
  const logger = new MessageLogger(logFilePath);
  const counterpart = { role: "consumer", deviceId: "device-1" };

  logger.log("received", counterpart, "task.submit", { type: "task.submit", requestId: "request-1", input: { taskType: "task_type_llm_qwen3_0_6b_sharded", input: "What is the capital of France?" } });
  logger.log("sent", counterpart, "stage.assign", { type: "stage.assign", taskId: "task-1", stage: "stage_dev_formula_multiply", value: 5 });

  const entries = readFileSync(logFilePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LogEntry);
  rmSync(directoryPath, { recursive: true, force: true });

  assert.deepEqual(entries[0].payload, { type: "task.submit", requestId: "request-1", input: { taskType: "task_type_llm_qwen3_0_6b_sharded", input: "[redacted]" } });
  assert.deepEqual(entries[1].payload, { type: "stage.assign", taskId: "task-1", stage: "stage_dev_formula_multiply", value: "[redacted]" });
});

test("redacts the task result, the values inside completed stages, and a relayed message", () => {
  const redacted = MessageLogger.redactPayload({
    type: "task.updated",
    update: { taskId: "task-1", state: "completed", result: { text: "SECRET ANSWER" } },
  }) as { update: { result: unknown } };
  assert.equal(redacted.update.result, "[redacted]");

  const snapshot = MessageLogger.redactPayload({
    type: "task.snapshot",
    task: { taskId: "task-1", completedStages: [{ name: "stage_llm_qwen3_0_6b_shard1of3", value: { text: "SECRET STAGE" } }] },
  }) as { task: { completedStages: { name: string; value: unknown }[] } };
  assert.deepEqual(snapshot.task.completedStages, [{ name: "stage_llm_qwen3_0_6b_shard1of3", value: "[redacted]" }]);

  // Redaction still reaches a value nested inside another message, which is the shape a
  // gateway message carrying a task takes.
  const nested = MessageLogger.redactPayload({
    type: "stage.assign",
    assignment: { taskId: "task-1", value: { text: "SECRET PROMPT" } },
  }) as { assignment: { value: unknown } };
  assert.equal(nested.assignment.value, "[redacted]");
});

test("redacts the authentication token", () => {
  const redacted = MessageLogger.redactPayload({ type: "authenticate", token: "development-token" }) as { token: unknown };
  assert.equal(redacted.token, "[redacted]");
});

test("leaves the message it redacts unmodified", () => {
  const original = { type: "task.updated", update: { result: 17 } };
  MessageLogger.redactPayload(original);
  assert.equal(original.update.result, 17);
});

test("accepts a lease heartbeat and the stage settings that control leasing", () => {
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.heartbeat", taskId: "task-1", assignmentId: "assignment-1", attempt: 1 }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.heartbeat", taskId: "task-1", assignmentId: "assignment-1" }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.heartbeat", taskId: "task-1", assignmentId: "assignment-1", attempt: 0 }).success, false);

  const stage = { name: "stage_dev_formula_multiply", computation: "dev_formula_multiply", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" } as const;
  assert.equal(PipelineStageSchema.safeParse({ ...stage, leaseMs: 60_000, prefersSameWorkerOnRetry: true }).success, true);
  // A stage that states neither setting is valid, and takes the gateway's --lease-ms default.
  assert.equal(PipelineStageSchema.safeParse(stage).success, true);
  assert.equal(PipelineStageSchema.safeParse({ ...stage, leaseMs: 0 }).success, false);
  assert.equal(PipelineStageSchema.safeParse({ ...stage, leaseMs: -1 }).success, false);
});

test("rejects malformed and oversized identity-bearing task messages", () => {
  assert.equal(ClientMessageSchema.safeParse({ type: "task.submit", requestId: "", input: { taskType: "task_type_dev_formula", input: 5 } }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.result", taskId: "task-1", assignmentId: "assignment-1", attempt: 0, stage: "stage_dev_formula_multiply", value: 10 }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.failed", taskId: "task-1", assignmentId: "assignment-1", attempt: 1, stage: "stage_dev_formula_multiply", error: "x".repeat(10_001) }).success, false);
});

/**
 * Builds a task record that has run many language-model shards, so the growth of the
 * stored record can be told apart from the size of what goes over the connection.
 *
 * @param shardCount - How many shard assignments the task has already run.
 * @returns The stored task record.
 */
function buildLlmTask(shardCount: number): Task {
  const tensorPayload = StagePayloadFactory.llmHandoff({ hidden: { dataBase64: "A".repeat(4_000), dims: [1, 2], type: "float32" } }, [1], 0);
  const assignmentAttempts = Array.from({ length: shardCount }, (_unused, index) => ({
    workerDeviceId: "device-worker",
    assignmentId: `assignment-${index}`,
    attempt: 1,
    stage: "stage_llm_qwen3_0_6b_shard1of3" as const,
    value: tensorPayload,
    leaseUntil: "2026-01-01T00:00:15.000Z",
  }));
  const events: TaskEvent[] = Array.from({ length: shardCount }, (_unused, index) => ({
    type: "assignment_created" as const,
    timestamp: "2026-01-01T00:00:00.000Z",
    assignmentId: `assignment-${index}`,
    attempt: 1,
  }));
  return {
    taskId: "task-1",
    requestId: "request-1",
    consumerDeviceId: "device-consumer",
    consumerPrincipal: "principal-1",
    input: { taskType: "task_type_llm_qwen3_0_6b_sharded", input: "What is the capital of France?" },
    state: "running",
    completedStages: assignmentAttempts.map((assignment) => ({ name: assignment.stage, value: tensorPayload })),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    assignment: assignmentAttempts.at(-1),
    assignmentAttempts,
    currentStageAttempts: 1,
    events,
    submissionDeadlineAt: "2026-01-01T00:00:30.000Z",
    revision: shardCount,
  };
}

test("the task update sent on every revision does not grow as a task runs more stages", () => {
  const shortTask = buildLlmTask(3);
  const longTask = buildLlmTask(300);

  const shortUpdateBytes = JSON.stringify(TaskProjection.update(shortTask)).length;
  const longUpdateBytes = JSON.stringify(TaskProjection.update(longTask)).length;

  // The stored record grows with the number of stages run; the task update must not.
  assert.ok(JSON.stringify(longTask).length > JSON.stringify(shortTask).length * 50);
  // The only difference between the two updates is the extra digits in the revision, the
  // completed stage count, and the assignment identifier, so it grows with the number of
  // digits rather than with the number of stages.
  assert.equal(longUpdateBytes - shortUpdateBytes, 6);
  assert.ok(longUpdateBytes < 400);
});

test("no stage value appears in a task update, and none appears twice", () => {
  const update = TaskProjection.update(buildLlmTask(5));
  const serialised = JSON.stringify(update);

  assert.equal(serialised.includes("dataBase64"), false);
  assert.equal(serialised.includes("AAAA"), false);
  assert.equal("value" in (update.assignment ?? {}), false);
  assert.equal(update.completedStageCount, 5);
  assert.equal(update.currentStage, "stage_llm_qwen3_0_6b_shard1of3");
});

test("the task snapshot drops the attempt history and truncates the change log", () => {
  const task = buildLlmTask(50);
  const snapshot = TaskProjection.snapshot(task);

  assert.equal("assignmentAttempts" in snapshot, false);
  assert.equal("events" in snapshot, false);
  assert.equal(snapshot.recentEvents.length, maximumSnapshotEventCount);
  assert.deepEqual(snapshot.recentEvents.at(-1), task.events.at(-1));
  assert.equal("value" in (snapshot.assignment ?? {}), false);
  assert.equal(snapshot.input.input, "What is the capital of France?");
});

test("a pipeline stage names the computation a worker must run, and a pipeline may repeat", () => {
  const stage = { name: "stage_anything", computation: "dev_formula_multiply", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" } as const;
  // The stage name is free; the computation is what a worker matches on.
  assert.equal(PipelineStageSchema.safeParse(stage).success, true);
  assert.equal(PipelineStageSchema.safeParse({ ...stage, computation: undefined }).success, false);
  assert.equal(PipelineStageSchema.safeParse({ ...stage, computation: "Formula Multiply" }).success, false);

  assert.equal(PipelineSpecificationSchema.safeParse({
    pipelineId: "invented", version: 1, taskType: "task_type_dev_formula", repeatsUntilDone: true, stages: [stage],
  }).success, true);
  assert.equal(PipelineSpecificationSchema.safeParse({
    pipelineId: "invented", version: 1, taskType: "task_type_dev_formula", stages: [stage, stage],
  }).success, false);
});

test("every frame states its version, its own identifier, and when it was sent", () => {
  const frame = Envelope.fromClient({ type: "authenticate", token: "development-token" });
  assert.equal(frame.v, protocolVersion);
  assert.ok(frame.id.length > 0);
  assert.ok(Number.isFinite(Date.parse(frame.ts)));
  assert.equal(ClientEnvelopeSchema.safeParse(frame).success, true);

  // Two frames of the same kind can be told apart, which is what lets a client match two
  // requests in flight at once to their own answers.
  assert.notEqual(Envelope.fromClient({ type: "devices.resync" }).id, Envelope.fromClient({ type: "devices.resync" }).id);

  // A frame with no message in it, an unknown field, or a bad timestamp is refused.
  assert.equal(ClientEnvelopeSchema.safeParse({ v: 1, id: "message-1", ts: new Date().toISOString() }).success, false);
  assert.equal(ClientEnvelopeSchema.safeParse({ ...frame, unexpected: true }).success, false);
  assert.equal(ClientEnvelopeSchema.safeParse({ ...frame, ts: "not-a-time" }).success, false);
});

test("a gateway answer names the request it answers, and a push names nothing", () => {
  const request = Envelope.fromClient({ type: "devices.resync" });
  const answer = Envelope.fromGateway({ type: "devices", devices: [], revision: 1 }, request.id);
  const push = Envelope.fromGateway({ type: "devices", devices: [], revision: 2 });

  assert.equal(answer.inReplyTo, request.id);
  // The push carries the same message type as the answer. The absence of inReplyTo is the
  // only thing that tells them apart, which is the point of the field.
  assert.equal(push.inReplyTo, undefined);
  assert.notEqual(answer.id, push.id);
});

test("recognises a message sent without its wrapper, and reports which versions are supported", () => {
  assert.equal(Envelope.isUnwrappedMessage({ type: "authenticate", token: "development-token" }), true);
  assert.equal(Envelope.isUnwrappedMessage(Envelope.fromClient({ type: "devices.resync" })), false);
  assert.equal(Envelope.isUnwrappedMessage("not an object"), false);

  assert.equal(Envelope.supportsVersion(protocolVersion), true);
  assert.equal(Envelope.supportsVersion(protocolVersion + 1), false);
});

test("diagnostics travel off the scheduling connection, under a schema rather than as unknown", () => {
  // The scheduling connection no longer carries diagnostic traffic at all.
  assert.equal(ClientMessageSchema.safeParse({ type: "log.entry", direction: "sent", messageType: "stage.result", timestamp: new Date().toISOString(), payload: {} }).success, false);

  const validBatch = {
    deviceId: "device-11111111-2222-3333-4444-555555555555",
    entries: [{ direction: "sent" as const, messageType: "stage.result", timestamp: new Date().toISOString(), messageId: "message-1" }],
  };
  assert.equal(DiagnosticsBatchSchema.safeParse(validBatch).success, true);

  // A report carries timing only. Anything carrying a message body is refused outright,
  // which is what keeps task data off this path rather than relying on redaction alone.
  const withBody = { ...validBatch, entries: [{ ...validBatch.entries[0], payload: { input: "a secret prompt" } }] };
  assert.equal(DiagnosticsBatchSchema.safeParse(withBody).success, false);

  // The batch size is bounded, so one report cannot be arbitrarily large.
  const oversized = {
    deviceId: validBatch.deviceId,
    entries: Array.from({ length: maximumDiagnosticEntriesPerBatch + 1 }, () => validBatch.entries[0]),
  };
  assert.equal(DiagnosticsBatchSchema.safeParse(oversized).success, false);

  assert.equal(DiagnosticsBatchSchema.safeParse({ deviceId: validBatch.deviceId, entries: [] }).success, false);
  assert.equal(DiagnosticsBatchSchema.safeParse({ entries: validBatch.entries }).success, false);
});

test("a long-lived client renews halfway through its session", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");

  // Halfway through, so a renewal that is lost or late still leaves as much time again for
  // another attempt before the session actually runs out.
  assert.equal(SessionRenewal.renewAfterMs("2026-07-29T13:00:00.000Z", now), 1_800_000);
  assert.equal(SessionRenewal.renewAfterMs("2026-07-29T12:00:10.000Z", now), 5_000);

  // A session already expired, or about to be, never produces a zero or negative wait that
  // would spin the client.
  assert.equal(SessionRenewal.renewAfterMs("2026-07-29T11:00:00.000Z", now), 1_000);
  assert.equal(SessionRenewal.renewAfterMs("2026-07-29T12:00:00.000Z", now), 1_000);
  assert.equal(SessionRenewal.renewAfterMs("not a date", now), 1_000);
});
