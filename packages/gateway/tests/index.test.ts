// node imports
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

// local imports
import { DeviceRegistry } from "../src/libs/device_registry.js";
import { TaskStore } from "../src/libs/task_store.js";
import { PipelineRegistry, builtinPipelineSpecifications } from "../src/libs/pipeline_registry.js";
import { StagePolicyResolver } from "../src/libs/stage_policy_resolver.js";
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

test("selects a pinned compatible pipeline version and rejects invalid definitions", () => {
  const registry = new PipelineRegistry(builtinPipelineSpecifications);
  assert.equal(registry.select({ taskType: "task_type_formula", input: 5 })?.pipelineId, "formula");
  assert.equal(registry.select({ taskType: "task_type_formula", input: 5 }, "formula", 1)?.version, 1);
  assert.throws(() => registry.add({ pipelineId: "bad", version: 1, taskType: "task_type_formula", stages: [] }));
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

test("keeps consumer request identifiers and assignment ownership in task state", () => {
  const store = new TaskStore();
  const task = store.create({ taskType: "task_type_formula", input: 5 }, "consumer-1", "request-1");

  assert.equal(store.findByRequest("consumer-1", "request-1")?.taskId, task.taskId);
  assert.equal(store.findByRequest("consumer-2", "request-1"), undefined);

  const assigned = store.assign(task.taskId, "worker-1", "stage_formula_multiply", 5);
  assert.deepEqual(assigned.assignment, {
    workerDeviceId: "worker-1",
    assignmentId: assigned.assignment?.assignmentId,
    attempt: 1,
    stage: "stage_formula_multiply",
    value: 5,
	leaseUntil: assigned.assignment?.leaseUntil,
  });

  const completed = store.addStage(task.taskId, { name: "stage_formula_multiply", value: 10 });
  assert.equal(completed.assignment, undefined);
});

test("keeps repeated request identifiers idempotent and rejects stale assignment state", () => {
  const store = new TaskStore();
  const original = store.create({ taskType: "task_type_formula", input: 5 }, "consumer-1", "request-1");
  assert.equal(store.findByRequest("consumer-1", "request-1")?.taskId, original.taskId);
  const first = store.assign(original.taskId, "worker-1", "stage_formula_multiply", 5);
  const replacement = store.assign(original.taskId, "worker-2", "stage_formula_multiply", 5, "worker_relinquished");
  assert.notEqual(first.assignment?.assignmentId, replacement.assignment?.assignmentId);
  assert.equal(replacement.assignment?.workerDeviceId, "worker-2");
  assert.equal(replacement.assignmentAttempts.length, 2);
});

test("records deterministic lease attempts, acknowledgement, and cancellation", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const store = new TaskStore(() => now, 1000, 500);
  const task = store.create({ taskType: "task_type_formula", input: 5 }, "consumer-1", "request-1");
  assert.equal(task.state, "queued");
  assert.equal(task.submissionDeadlineAt, "2026-01-01T00:00:01.000Z");

  const assigned = store.assign(task.taskId, "worker-1", "stage_formula_multiply", 5);
  assert.equal(assigned.state, "assigned");
  assert.equal(assigned.assignment?.leaseUntil, "2026-01-01T00:00:00.500Z");
  const running = store.acceptAssignment(task.taskId);
  assert.equal(running.state, "running");
  assert.equal(running.assignment?.acceptedAt, "2026-01-01T00:00:00.000Z");
  const retried = store.assign(task.taskId, "worker-2", "stage_formula_multiply", 5, "lease_expired");
  assert.equal(retried.assignment?.attempt, 2);
  assert.equal(retried.events.at(-1)?.reason, "lease_expired");
  const cancelled = store.cancel(task.taskId, "consumer_requested");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.assignment, undefined);
});

test("restores durable task records and idempotency after a new TaskStore instance", () => {
  const directory = mkdtempSync(join(tmpdir(), "webai-task-store-"));
  const stateFile = join(directory, "state.json");
  try {
    const first = new TaskStore(undefined, 30_000, 15_000, stateFile);
    const task = first.create({ taskType: "task_type_formula", input: 5 }, "consumer-1", "request-1");
    first.assign(task.taskId, "worker-1", "stage_formula_multiply", 5);

    const restored = new TaskStore(undefined, 30_000, 15_000, stateFile);
    assert.equal(restored.findByRequest("consumer-1", "request-1")?.taskId, task.taskId);
    assert.equal(restored.get(task.taskId)?.assignment?.stage, "stage_formula_multiply");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("resets the retry budget after each successful LLM stage", () => {
  const store = new TaskStore();
  const task = store.create({ taskType: "task_type_llm", input: "hello" });
  let current = store.assign(task.taskId, "worker-1", "stage_llm_shard1", { text: "hello" });
  assert.equal(current.assignment?.attempt, 1);
  current = store.addStage(current.taskId, { name: "stage_llm_shard1", value: { tensors: {} } });
  assert.equal(current.currentStageAttempts, 0);
  current = store.assign(current.taskId, "worker-2", "stage_llm_shard2", { tensors: {} });
  assert.equal(current.assignment?.attempt, 1);
  current = store.addStage(current.taskId, { name: "stage_llm_shard2", value: { tensors: {} } });
  current = store.assign(current.taskId, "worker-3", "stage_llm_shard3", { tensors: {} });
  current = store.addStage(current.taskId, { name: "stage_llm_shard3", value: { text: "The", done: false } });
  current = store.assign(current.taskId, "worker-1", "stage_llm_shard1", { text: "The", done: false });
  assert.equal(current.assignment?.attempt, 1);
});

test("tells a device joining apart from a change to its description, its activity, and its liveness", () => {
  const registry = new DeviceRegistry();
  const first = registry.add(worker("one", ["stage_formula_multiply"]));
  assert.equal(first.kind, "joined");

  const stored = registry.get("one")!;
  const touched = registry.add({ ...stored, lastSeenAt: "2026-01-01T00:00:05.000Z" });
  const busy = registry.add({ ...registry.get("one")!, activeAssignments: 1, lastSeenAt: "2026-01-01T00:00:06.000Z" });
  const renamed = registry.add({ ...registry.get("one")!, name: "worker-renamed" });
  const restaged = registry.add({ ...registry.get("one")!, stageNames: ["stage_formula_add"] });

  assert.equal(touched.kind, "unchanged");
  assert.equal(busy.kind, "activity_changed");
  assert.equal(renamed.kind, "stable_changed");
  assert.equal(restaged.kind, "stable_changed");
  // A refreshed liveness timestamp is stored but spends no membership revision, so a
  // device that merely keeps sending messages does not move the revision counter.
  assert.equal(touched.revision, first.revision);
  assert.equal(registry.get("one")?.lastSeenAt, "2026-01-01T00:00:06.000Z");
  assert.equal(registry.membershipRevision(), restaged.revision);
});

test("a lease renewal extends the lease without raising the task revision", () => {
  const store = new TaskStore(undefined, 30_000, 2_000);
  const task = store.create({ taskType: "task_type_formula", input: 5 }, "consumer-1", "request-1");
  const assigned = store.assign(task.taskId, "worker-1", "stage_formula_multiply", 5);
  const before = store.get(task.taskId)!;

  const leaseUntil = store.renewLease(task.taskId, 60_000)!;
  const after = store.get(task.taskId)!;

  assert.ok(Date.parse(leaseUntil) > Date.parse(assigned.assignment!.leaseUntil));
  assert.equal(after.assignment?.leaseUntil, leaseUntil);
  // A heartbeat says only that the worker is still alive. Raising the revision would send a
  // task update to every reader on every heartbeat.
  assert.equal(after.revision, before.revision);
  assert.equal(after.updatedAt, before.updatedAt);
  // The per-attempt history holds the same assignment and must not drift from it.
  assert.equal(after.assignmentAttempts.at(-1)?.leaseUntil, leaseUntil);
});

test("a stage assignment can be given a lease shorter or longer than the store default", () => {
  const store = new TaskStore(undefined, 30_000, 2_000);
  const task = store.create({ taskType: "task_type_formula", input: 5 }, "consumer-1", "request-1");
  const assigned = store.assign(task.taskId, "worker-1", "stage_formula_multiply", 5, undefined, 60_000);
  assert.ok(Date.parse(assigned.assignment!.leaseUntil) - Date.now() > 30_000);
});

test("stage settings come from the pipeline specification, and language-model shards keep their worker", () => {
  const registry = new PipelineRegistry(builtinPipelineSpecifications);
  registry.add({
    pipelineId: "formula", version: 2, taskType: "task_type_formula",
    stages: [
      { name: "stage_formula_multiply", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json", leaseMs: 9_000, prefersSameWorkerOnRetry: true },
      { name: "stage_formula_add", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" },
    ],
  });
  const resolver = new StagePolicyResolver(registry, 2_000);
  const store = new TaskStore(undefined, 30_000, 2_000);

  const specified = store.create({ taskType: "task_type_formula", input: 5 }, "consumer-1", "request-1", undefined, { pipelineId: "formula", pipelineVersion: 2 });
  assert.deepEqual(resolver.resolve(specified, "stage_formula_multiply"), { leaseMs: 9_000, prefersSameWorkerOnRetry: true });
  // A stage that states no lease of its own falls back to the gateway's --lease-ms default.
  assert.deepEqual(resolver.resolve(specified, "stage_formula_add"), { leaseMs: 2_000, prefersSameWorkerOnRetry: false });

  // The built-in language-model pipeline has no specification, because its three shards
  // cycle once per generated token rather than running once each. Its shards keep their
  // worker anyway, so a retry does not throw away the key-value cache.
  const builtin = store.create({ taskType: "task_type_llm", input: "hello" }, "consumer-1", "request-2");
  assert.deepEqual(resolver.resolve(builtin, "stage_llm_shard1"), { leaseMs: 2_000, prefersSameWorkerOnRetry: true });
  assert.deepEqual(resolver.resolve(builtin, "stage_formula_multiply"), { leaseMs: 2_000, prefersSameWorkerOnRetry: false });
});
