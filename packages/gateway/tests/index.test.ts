// node imports
import assert from "node:assert/strict";
import test from "node:test";

// local imports
import { DeviceRegistry } from "../src/libs/device_registry.js";
import { TaskStore } from "../src/libs/task_store.js";
import { splitDevices, stageStatistics } from "../src/dashboard.js";

const worker = (deviceId: string, stageNames: ("stage_formula_multiply" | "stage_formula_add")[] = ["stage_formula_multiply", "stage_formula_add"]) => ({
  deviceId,
  name: `worker-${deviceId}`,
  deviceRole: "worker" as const,
  stageNames,
  connectedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
});

const consumer = (deviceId: string) => ({
  deviceId,
  name: `consumer-${deviceId}`,
  deviceRole: "consumer" as const,
  stageNames: [] as [],
  connectedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
});

test("dashboard payload keeps workers and consumers available as separate groups", () => {
  const devices = splitDevices([worker("one"), consumer("two")]);

  assert.deepEqual(devices.worker.map((device) => device.deviceId), ["one"]);
  assert.deepEqual(devices.consumer.map((device) => device.deviceId), ["two"]);
});

test("calculates enabled-stage percentages using all advertised capabilities", () => {
  const statistics = stageStatistics([
    worker("one", ["stage_formula_multiply", "stage_formula_add"]),
    worker("two", ["stage_formula_multiply"]),
  ]);

  assert.equal(statistics.total, 3);
  assert.deepEqual(statistics.stages.map(({ stageName, count, percentage }) => ({
    stageName,
    count,
    percentage: Number(percentage.toFixed(1)),
  })), [
    { stageName: "stage_formula_add", count: 1, percentage: 33.3 },
    { stageName: "stage_formula_multiply", count: 2, percentage: 66.7 },
  ]);
});

test("finds workers by capability and excludes devices", () => {
  const registry = new DeviceRegistry();
  registry.add(worker("one", ["stage_formula_multiply"]));
  registry.add(worker("two", ["stage_formula_add"]));

  assert.equal(registry.findWorker("stage_formula_multiply")?.deviceId, "one");
  assert.equal(registry.findWorker("stage_formula_multiply", ["one"]), undefined);
  assert.equal(registry.findByName("worker-two", "worker")?.deviceId, "two");
});

test("creates tasks and advances through both stages", () => {
  const store = new TaskStore();
  const task = store.create({ taskType: "task_type_formula", input: 5 });

  assert.equal(task.state, "queued");
  assert.equal(TaskStore.nextStage(task), "stage_formula_multiply");

  const afterMultiply = store.addStage(task.taskId, { name: "stage_formula_multiply", value: 10 });
  assert.equal(TaskStore.nextStage(afterMultiply), "stage_formula_add");

  const afterAdd = store.addStage(task.taskId, { name: "stage_formula_add", value: 17 });
  const completed = store.update(afterAdd.taskId, { state: "completed", result: 17 });
  assert.equal(TaskStore.nextStage(completed), undefined);
  assert.equal(store.get(task.taskId)?.result, 17);
});

test("loops an LLM task through its three shards once per generated token", () => {
  const store = new TaskStore();
  const task = store.create({ taskType: "task_type_llm", input: "What is the capital of France?" });

  assert.equal(TaskStore.nextStage(task), "stage_llm_shard1");

  let current = task;
  for (const stage of ["stage_llm_shard1", "stage_llm_shard2"] as const) {
    current = store.addStage(current.taskId, { name: stage, value: { tensors: {} } });
  }
  assert.equal(TaskStore.nextStage(current), "stage_llm_shard3");

  const afterFirstToken = store.addStage(current.taskId, { name: "stage_llm_shard3", value: { text: "The", done: false } });
  assert.equal(TaskStore.nextStage(afterFirstToken), "stage_llm_shard1");

  current = afterFirstToken;
  for (const stage of ["stage_llm_shard1", "stage_llm_shard2"] as const) {
    current = store.addStage(current.taskId, { name: stage, value: { tensors: {} } });
  }
  const afterSecondToken = store.addStage(current.taskId, { name: "stage_llm_shard3", value: { text: "The capital", done: true } });
  assert.equal(TaskStore.nextStage(afterSecondToken), undefined);
});
