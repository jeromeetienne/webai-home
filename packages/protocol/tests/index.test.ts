import assert from "node:assert/strict";
import test from "node:test";
import { StageName, StagePayloadFactory, TaskInput, TaskState } from "../src/index.js";

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
