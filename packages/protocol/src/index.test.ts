import assert from "node:assert/strict";
import test from "node:test";
import { StageName, TaskInput, TaskState } from "./index.js";

test("accepts valid task input", () => {
  assert.deepEqual(TaskInput.parse({ input: 12.5 }), { input: 12.5 });
});

test("rejects non-finite task input", () => {
  assert.equal(TaskInput.safeParse({ input: Number.NaN }).success, false);
  assert.equal(TaskInput.safeParse({ input: Infinity }).success, false);
});

test("restricts task states and stage names", () => {
  assert.equal(TaskState.safeParse("completed").success, true);
  assert.equal(TaskState.safeParse("unknown").success, false);
  assert.equal(StageName.safeParse("multiply").success, true);
  assert.equal(StageName.safeParse("divide").success, false);
});
