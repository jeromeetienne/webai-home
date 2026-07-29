import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClientMessageSchema, StageName, StagePayloadFactory, TaskInput, TaskState } from "../src/index.js";
import { MessageLogger } from "../src/message_logger.js";
import type { LogEntry } from "../src/message_logger.js";

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

test("rejects malformed and oversized identity-bearing task messages", () => {
  assert.equal(ClientMessageSchema.safeParse({ type: "task.submit", requestId: "", input: { taskType: "task_type_formula", input: 5 } }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.result", taskId: "task-1", assignmentId: "assignment-1", attempt: 0, stage: "stage_formula_multiply", value: 10 }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: "stage.failed", taskId: "task-1", assignmentId: "assignment-1", attempt: 1, stage: "stage_formula_multiply", error: "x".repeat(10_001) }).success, false);
});
