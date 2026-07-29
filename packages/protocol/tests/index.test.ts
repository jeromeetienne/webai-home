import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClientMessageSchema, StageName, StagePayloadFactory, TaskInput, TaskState, maximumSnapshotEventCount } from "../src/index.js";
import type { Task, TaskEvent } from "../src/index.js";
import { MessageLogger } from "../src/message_logger.js";
import type { LogEntry } from "../src/message_logger.js";
import { TaskProjection } from "../src/task_projection.js";

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

test("restricts task states and stage names", () => {
  assert.equal(TaskState.safeParse("completed").success, true);
  assert.equal(TaskState.safeParse("unknown").success, false);
  assert.equal(StageName.safeParse("stage_formula_multiply").success, true);
  assert.equal(StageName.safeParse("divide").success, false);
});

test("accepts the three LLM shard stage names", () => {
  assert.equal(StageName.safeParse("stage_llm_shard1").success, true);
  assert.equal(StageName.safeParse("stage_llm_shard2").success, true);
  assert.equal(StageName.safeParse("stage_llm_shard3").success, true);
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
