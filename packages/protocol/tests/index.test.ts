import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClientEnvelopeSchema, ClientMessageSchema, PipelineSpecificationSchema, PipelineStageSchema, StageName, StagePayloadFactory, TaskInput, TaskState, maximumSnapshotEventCount, protocolVersion } from "../src/index.js";
import type { Task, TaskEvent } from "../src/index.js";
import { MessageLogger } from "../src/message_logger.js";
import type { LogEntry } from "../src/message_logger.js";
import { TaskProjection } from "../src/task_projection.js";
import { Envelope } from "../src/envelope.js";

test("accepts valid task input", () => {
  assert.deepEqual(TaskInput.parse({ taskType: "task_type_formula", input: 12.5 }), { taskType: "task_type_formula", input: 12.5 });
  assert.deepEqual(TaskInput.parse({ taskType: "task_type_llm", input: "hello" }), { taskType: "task_type_llm", input: "hello" });
});

test("rejects non-finite task input", () => {
  assert.equal(TaskInput.safeParse({ taskType: "task_type_formula", input: Number.NaN }).success, false);
  assert.equal(TaskInput.safeParse({ taskType: "task_type_formula", input: Infinity }).success, false);
});

test("rejects task input that does not match its task type", () => {
  assert.equal(TaskInput.safeParse({ taskType: "task_type_llm", input: 5 }).success, false);
  assert.equal(TaskInput.safeParse({ taskType: "task_type_formula", input: "5" }).success, false);
});

test("restricts task states, and checks the shape of a stage name without listing them", () => {
  assert.equal(TaskState.safeParse("completed").success, true);
  assert.equal(TaskState.safeParse("unknown").success, false);
  assert.equal(StageName.safeParse("stage_formula_multiply").success, true);
  assert.equal(StageName.safeParse("stage_llm_shard1").success, true);
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
  assert.deepEqual(StagePayloadFactory.llmDone("The capital of France is Paris."), { text: "The capital of France is Paris.", done: true });
});

test("validates every inbound client message shape", () => {
  assert.equal(ClientMessageSchema.safeParse({ type: "task.submit", requestId: "request-1", input: { taskType: "task_type_formula", input: 5 } }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.result", taskId: "task-1", assignmentId: "assignment-1", attempt: 1, stage: "stage_formula_multiply", value: 10 }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "task.submit", input: { taskType: "task_type_formula", input: 5 } }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.result", taskId: "task-1", stage: "stage_formula_multiply", value: 10 }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "register", role: "consumer", name: "consumer", unexpected: true }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "task.history", taskId: "task-1" }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: "task.history" }).success, false);
});

test("redacts task inputs and stage values but keeps the task type", () => {
  const directoryPath = mkdtempSync(join(tmpdir(), "message-logger-"));
  const logFilePath = join(directoryPath, "log.jsonl");
  const logger = new MessageLogger(logFilePath);
  const counterpart = { role: "consumer", deviceId: "device-1" };

  logger.log("received", counterpart, "task.submit", { type: "task.submit", requestId: "request-1", input: { taskType: "task_type_llm", input: "What is the capital of France?" } });
  logger.log("sent", counterpart, "stage.assign", { type: "stage.assign", taskId: "task-1", stage: "stage_formula_multiply", value: 5 });

  const entries = readFileSync(logFilePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LogEntry);
  rmSync(directoryPath, { recursive: true, force: true });

  assert.deepEqual(entries[0].payload, { type: "task.submit", requestId: "request-1", input: { taskType: "task_type_llm", input: "[redacted]" } });
  assert.deepEqual(entries[1].payload, { type: "stage.assign", taskId: "task-1", stage: "stage_formula_multiply", value: "[redacted]" });
});

test("redacts the task result, the values inside completed stages, and a relayed message", () => {
  const redacted = MessageLogger.redactPayload({
    type: "task.updated",
    update: { taskId: "task-1", state: "completed", result: { text: "SECRET ANSWER" } },
  }) as { update: { result: unknown } };
  assert.equal(redacted.update.result, "[redacted]");

  const snapshot = MessageLogger.redactPayload({
    type: "task.snapshot",
    task: { taskId: "task-1", completedStages: [{ name: "stage_llm_shard1", value: { text: "SECRET STAGE" } }] },
  }) as { task: { completedStages: { name: string; value: unknown }[] } };
  assert.deepEqual(snapshot.task.completedStages, [{ name: "stage_llm_shard1", value: "[redacted]" }]);

  const relayed = MessageLogger.redactPayload({
    type: "log.entry",
    messageType: "stage.assign",
    payload: { type: "stage.assign", taskId: "task-1", value: { text: "SECRET PROMPT" } },
  }) as { payload: { value: unknown } };
  assert.equal(relayed.payload.value, "[redacted]");
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

  const stage = { name: "stage_formula_multiply", computation: "formula_multiply", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" } as const;
  assert.equal(PipelineStageSchema.safeParse({ ...stage, leaseMs: 60_000, prefersSameWorkerOnRetry: true }).success, true);
  // A stage that states neither setting is valid, and takes the gateway's --lease-ms default.
  assert.equal(PipelineStageSchema.safeParse(stage).success, true);
  assert.equal(PipelineStageSchema.safeParse({ ...stage, leaseMs: 0 }).success, false);
  assert.equal(PipelineStageSchema.safeParse({ ...stage, leaseMs: -1 }).success, false);
});

test("rejects malformed and oversized identity-bearing task messages", () => {
  assert.equal(ClientMessageSchema.safeParse({ type: "task.submit", requestId: "", input: { taskType: "task_type_formula", input: 5 } }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.result", taskId: "task-1", assignmentId: "assignment-1", attempt: 0, stage: "stage_formula_multiply", value: 10 }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.failed", taskId: "task-1", assignmentId: "assignment-1", attempt: 1, stage: "stage_formula_multiply", error: "x".repeat(10_001) }).success, false);
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
    stage: "stage_llm_shard1" as const,
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
    input: { taskType: "task_type_llm", input: "What is the capital of France?" },
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
  assert.equal(update.currentStage, "stage_llm_shard1");
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
  const stage = { name: "stage_anything", computation: "formula_multiply", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" } as const;
  // The stage name is free; the computation is what a worker matches on.
  assert.equal(PipelineStageSchema.safeParse(stage).success, true);
  assert.equal(PipelineStageSchema.safeParse({ ...stage, computation: undefined }).success, false);
  assert.equal(PipelineStageSchema.safeParse({ ...stage, computation: "Formula Multiply" }).success, false);

  assert.equal(PipelineSpecificationSchema.safeParse({
    pipelineId: "invented", version: 1, taskType: "task_type_formula", repeatsUntilDone: true, stages: [stage],
  }).success, true);
  assert.equal(PipelineSpecificationSchema.safeParse({
    pipelineId: "invented", version: 1, taskType: "task_type_formula", stages: [stage, stage],
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
