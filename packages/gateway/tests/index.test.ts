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
import { DiagnosticsRateLimiter } from "../src/libs/diagnostics_rate_limiter.js";
import { SessionRegistry } from "../src/libs/session_registry.js";
import { WorkerPlacement } from "../src/libs/worker_placement.js";
import { splitDevices, stageStatistics } from "../src/dashboard.js";
import type { StageName, TaskInput } from "@webai/protocol";

const worker = (deviceId: string, stageNames: StageName[] = ["stage_dev_formula_multiply", "stage_dev_formula_add"]) => ({
  deviceId,
  name: `worker-${deviceId}`,
  deviceRole: "worker" as const,
  stageNames,
  connectedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
});

/**
 * Creates a task the way the gateway does: by selecting a pipeline for the task input and
 * storing the stage sequence on the task. Every task carries a pipeline, so a task built
 * without one cannot be advanced.
 */
const createTask = (store: TaskStore, input: TaskInput, consumerDeviceId?: string, requestId?: string) => {
  const registry = new PipelineRegistry(builtinPipelineSpecifications);
  const pipeline = registry.select(input)!;
  return store.create(input, consumerDeviceId, requestId, undefined, {
    pipelineId: pipeline.pipelineId,
    pipelineVersion: pipeline.version,
    pipelineStages: pipeline.stages.map((stage) => stage.name),
    ...(pipeline.repeatsUntilDone === true ? { pipelineRepeatsUntilDone: true } : {}),
  });
};

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
    worker("one", ["stage_dev_formula_multiply", "stage_dev_formula_add"]),
    worker("two", ["stage_dev_formula_multiply"]),
  ]);

  assert.equal(statistics.total, 3);
  assert.deepEqual(statistics.stages.map(({ stageName, count, percentage }) => ({
    stageName,
    count,
    percentage: Number(percentage.toFixed(1)),
  })), [
    { stageName: "stage_dev_formula_add", count: 1, percentage: 33.3 },
    { stageName: "stage_dev_formula_multiply", count: 2, percentage: 66.7 },
  ]);
});

test("finds workers by capability and excludes devices", () => {
  const registry = new DeviceRegistry();
  registry.add(worker("one", ["stage_dev_formula_multiply"]));
  registry.add(worker("two", ["stage_dev_formula_add"]));

  assert.equal(registry.findWorker("stage_dev_formula_multiply")?.deviceId, "one");
  assert.equal(registry.findWorker("stage_dev_formula_multiply", ["one"]), undefined);
  assert.equal(registry.findByName("worker-two", "worker")?.deviceId, "two");
});

test("selects a pinned compatible pipeline version and rejects invalid definitions", () => {
  const registry = new PipelineRegistry(builtinPipelineSpecifications);
  assert.equal(registry.select({ taskType: "task_type_dev_formula", input: 5 })?.pipelineId, "dev_formula");
  assert.equal(registry.select({ taskType: "task_type_llm_gemma_nano_chrome_full", input: "hello" })?.pipelineId, "llm_gemma_nano_chrome_full");
  assert.equal(registry.select({ taskType: "task_type_dev_formula", input: 5 }, "dev_formula", 1)?.version, 1);
  assert.throws(() => registry.add({ pipelineId: "bad", version: 1, taskType: "task_type_dev_formula", stages: [] }));
});

test("creates tasks and advances through both stages", () => {
  const store = new TaskStore();
  const task = createTask(store, { taskType: "task_type_dev_formula", input: 5 });

  assert.equal(task.state, "queued");
  assert.equal(TaskStore.nextStage(task), "stage_dev_formula_multiply");

  const afterMultiply = store.addStage(task.taskId, { name: "stage_dev_formula_multiply", value: 10 });
  assert.equal(TaskStore.nextStage(afterMultiply), "stage_dev_formula_add");

  const afterAdd = store.addStage(task.taskId, { name: "stage_dev_formula_add", value: 17 });
  const completed = store.update(afterAdd.taskId, { state: "completed", result: 17 });
  assert.equal(TaskStore.nextStage(completed), undefined);
  assert.equal(store.get(task.taskId)?.result, 17);
});

test("keeps consumer request identifiers and assignment ownership in task state", () => {
  const store = new TaskStore();
  const task = createTask(store, { taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-1");

  assert.equal(store.findByRequest("consumer-1", "request-1")?.taskId, task.taskId);
  assert.equal(store.findByRequest("consumer-2", "request-1"), undefined);

  const assigned = store.assign(task.taskId, "worker-1", "stage_dev_formula_multiply", 5);
  assert.deepEqual(assigned.assignment, {
    workerDeviceId: "worker-1",
    assignmentId: assigned.assignment?.assignmentId,
    attempt: 1,
    stage: "stage_dev_formula_multiply",
    value: 5,
	leaseUntil: assigned.assignment?.leaseUntil,
  });

  const completed = store.addStage(task.taskId, { name: "stage_dev_formula_multiply", value: 10 });
  assert.equal(completed.assignment, undefined);
});

test("keeps repeated request identifiers idempotent and rejects stale assignment state", () => {
  const store = new TaskStore();
  const original = store.create({ taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-1");
  assert.equal(store.findByRequest("consumer-1", "request-1")?.taskId, original.taskId);
  const first = store.assign(original.taskId, "worker-1", "stage_dev_formula_multiply", 5);
  const replacement = store.assign(original.taskId, "worker-2", "stage_dev_formula_multiply", 5, "worker_relinquished");
  assert.notEqual(first.assignment?.assignmentId, replacement.assignment?.assignmentId);
  assert.equal(replacement.assignment?.workerDeviceId, "worker-2");
  assert.equal(replacement.assignmentAttempts.length, 2);
});

test("records deterministic lease attempts, acknowledgement, and cancellation", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const store = new TaskStore(() => now, 1000, 500);
  const task = createTask(store, { taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-1");
  assert.equal(task.state, "queued");
  assert.equal(task.submissionDeadlineAt, "2026-01-01T00:00:01.000Z");

  const assigned = store.assign(task.taskId, "worker-1", "stage_dev_formula_multiply", 5);
  assert.equal(assigned.state, "assigned");
  assert.equal(assigned.assignment?.leaseUntil, "2026-01-01T00:00:00.500Z");
  const running = store.acceptAssignment(task.taskId);
  assert.equal(running.state, "running");
  assert.equal(running.assignment?.acceptedAt, "2026-01-01T00:00:00.000Z");
  const retried = store.assign(task.taskId, "worker-2", "stage_dev_formula_multiply", 5, "lease_expired");
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
    const task = createTask(first, { taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-1");
    first.assign(task.taskId, "worker-1", "stage_dev_formula_multiply", 5);

    const restored = new TaskStore(undefined, 30_000, 15_000, stateFile);
    assert.equal(restored.findByRequest("consumer-1", "request-1")?.taskId, task.taskId);
    assert.equal(restored.get(task.taskId)?.assignment?.stage, "stage_dev_formula_multiply");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loops an LLM task through its three shards once per generated token", () => {
  const store = new TaskStore();
  const task = createTask(store, { taskType: "task_type_llm_qwen3_0_6b_sharded", input: "What is the capital of France?" });

  assert.equal(TaskStore.nextStage(task), "stage_llm_qwen3_0_6b_shard1of3");

  let current = task;
  for (const stage of ["stage_llm_qwen3_0_6b_shard1of3", "stage_llm_qwen3_0_6b_shard2of3"] as const) {
    current = store.addStage(current.taskId, { name: stage, value: { tensors: {} } });
  }
  assert.equal(TaskStore.nextStage(current), "stage_llm_qwen3_0_6b_shard3of3");

  const afterFirstToken = store.addStage(current.taskId, { name: "stage_llm_qwen3_0_6b_shard3of3", value: { text: "The", done: false } });
  assert.equal(TaskStore.nextStage(afterFirstToken), "stage_llm_qwen3_0_6b_shard1of3");

  current = afterFirstToken;
  for (const stage of ["stage_llm_qwen3_0_6b_shard1of3", "stage_llm_qwen3_0_6b_shard2of3"] as const) {
    current = store.addStage(current.taskId, { name: stage, value: { tensors: {} } });
  }
  const afterSecondToken = store.addStage(current.taskId, { name: "stage_llm_qwen3_0_6b_shard3of3", value: { text: "The capital", done: true } });
  assert.equal(TaskStore.nextStage(afterSecondToken), undefined);
});

test("repeats the single Chrome built-in language-model stage until it reports the answer finished", () => {
  const store = new TaskStore();
  const task = createTask(store, { taskType: "task_type_llm_gemma_nano_chrome_full", input: "What is the capital of France?" });

  assert.equal(task.pipelineId, "llm_gemma_nano_chrome_full");
  assert.deepEqual(task.pipelineStages, ["stage_llm_gemma_nano_chrome_full"]);
  assert.equal(TaskStore.nextStage(task), "stage_llm_gemma_nano_chrome_full");

  // Each run of the stage reads one more piece of the answer, so the stage runs again for as
  // long as its results say the answer is not finished.
  const afterFirstPiece = store.addStage(task.taskId, { name: "stage_llm_gemma_nano_chrome_full", value: { text: "The", isContinuation: true, done: false } });
  assert.equal(TaskStore.nextStage(afterFirstPiece), "stage_llm_gemma_nano_chrome_full");

  const afterSecondPiece = store.addStage(afterFirstPiece.taskId, { name: "stage_llm_gemma_nano_chrome_full", value: { text: "The capital", isContinuation: true, done: false } });
  assert.equal(TaskStore.nextStage(afterSecondPiece), "stage_llm_gemma_nano_chrome_full");

  const afterLastPiece = store.addStage(afterSecondPiece.taskId, { name: "stage_llm_gemma_nano_chrome_full", value: { text: "The capital of France is Paris.", done: true } });
  assert.equal(TaskStore.nextStage(afterLastPiece), undefined);
});

test("keeps a state-holding stage on its own device and moves a stateless one away", () => {
  const registry = new PipelineRegistry(builtinPipelineSpecifications);
  const resolver = new StagePolicyResolver(registry, 15_000);
  const store = new TaskStore();

  // This is the decision the gateway makes when it hands out the stage that follows a
  // finished one: a stage that keeps state in the memory of one device must be allowed back
  // onto the device that just ran a stage of the task, and a stage that keeps none is
  // preferably moved elsewhere. Each stage says which it is, so no task type decides it.
  const builtInModelTask = createTask(store, { taskType: "task_type_llm_gemma_nano_chrome_full", input: "hello" });
  assert.equal(resolver.resolve(builtInModelTask, "stage_llm_gemma_nano_chrome_full").prefersSameWorkerOnRetry, true);

  const shardTask = createTask(store, { taskType: "task_type_llm_qwen3_0_6b_sharded", input: "hello" });
  assert.equal(resolver.resolve(shardTask, "stage_llm_qwen3_0_6b_shard2of3").prefersSameWorkerOnRetry, true);

  const formulaTask = createTask(store, { taskType: "task_type_dev_formula", input: 5 });
  assert.equal(resolver.resolve(formulaTask, "stage_dev_formula_add").prefersSameWorkerOnRetry, false);

  // The built-in language-model stage also states a longer lease than the gateway default,
  // because creating the model session can take much longer than reading one piece of an answer.
  assert.equal(resolver.resolve(builtInModelTask, "stage_llm_gemma_nano_chrome_full").leaseMs, 60_000);
  assert.equal(resolver.resolve(formulaTask, "stage_dev_formula_add").leaseMs, 15_000);
});

test("a repeating stage is placed back on the device holding the task's answer", () => {
  const resolver = new StagePolicyResolver(new PipelineRegistry(builtinPipelineSpecifications), 15_000);
  const store = new TaskStore();
  const stage: StageName = "stage_llm_gemma_nano_chrome_full";
  const registry = new DeviceRegistry();
  // Two worker browser tabs advertise the same stage. The tab that does not hold the answer is
  // stored first, so a search for any free worker finds that one, which is what used to happen
  // for every run after the first.
  registry.add({ ...worker("device-two", [stage]), workerState: "ready", ready: true, maxConcurrentAssignments: 1, activeAssignments: 0 });
  registry.add({ ...worker("device-one", [stage]), workerState: "ready", ready: true, maxConcurrentAssignments: 1, activeAssignments: 0 });
  assert.equal(registry.findWorker(stage)?.deviceId, "device-two");

  const task = createTask(store, { taskType: "task_type_llm_gemma_nano_chrome_full", input: "hello" });
  store.assign(task.taskId, "device-one", stage, { text: "hello" });
  const afterFirstPiece = store.addStage(task.taskId, { name: stage, value: { text: "The", done: false } });

  // The device that ran the stage is recorded on the task, so the run that reads the next
  // piece of the same answer goes back to the tab holding the open generation.
  assert.deepEqual(afterFirstPiece.stageWorkerDeviceIds, { [stage]: "device-one" });
  const policy = resolver.resolve(afterFirstPiece, stage);
  const preferredDeviceId = WorkerPlacement.preferredWorkerDeviceId(afterFirstPiece, stage, policy, "device-one");
  assert.equal(preferredDeviceId, "device-one");
  assert.equal(WorkerPlacement.reusableWorker(registry, preferredDeviceId!, stage, { isPreviousAssignmentReleased: true })?.deviceId, "device-one");

  // A task waiting in the queue, with no device having just finished anything, is still pinned
  // to the tab holding the answer rather than to whichever tab is free.
  assert.equal(WorkerPlacement.preferredWorkerDeviceId(afterFirstPiece, stage, policy), "device-one");
});

test("the capacity check is not loosened when the previous assignment was already released", () => {
  const registry = new DeviceRegistry();
  const stage: StageName = "stage_llm_gemma_nano_chrome_full";
  const busy = { ...worker("device-one", [stage]), workerState: "ready" as const, ready: true, maxConcurrentAssignments: 1, activeAssignments: 1 };
  registry.add(busy);

  // A stage result releases the assignment before the next stage is placed, so the counter is
  // already correct. Discounting one here would let the worker hold two assignments while its
  // own limit is one.
  assert.equal(WorkerPlacement.reusableWorker(registry, "device-one", stage, { isPreviousAssignmentReleased: true }), undefined);
  // A lease expiry replaces an assignment the worker still holds, so that one assignment is
  // discounted and the worker can take the stage again.
  assert.equal(WorkerPlacement.reusableWorker(registry, "device-one", stage, { isPreviousAssignmentReleased: false })?.deviceId, "device-one");

  registry.add({ ...busy, activeAssignments: 0 });
  assert.equal(WorkerPlacement.reusableWorker(registry, "device-one", stage, { isPreviousAssignmentReleased: true })?.deviceId, "device-one");
  registry.add({ ...busy, maxConcurrentAssignments: 2, activeAssignments: 1 });
  assert.equal(WorkerPlacement.reusableWorker(registry, "device-one", stage, { isPreviousAssignmentReleased: true })?.deviceId, "device-one");

  // Every other condition a search for a free worker applies is applied to a named worker too.
  registry.add({ ...busy, activeAssignments: 0, workerState: "draining", ready: false });
  assert.equal(WorkerPlacement.reusableWorker(registry, "device-one", stage, { isPreviousAssignmentReleased: true }), undefined);
  registry.add({ ...busy, activeAssignments: 0, stageNames: ["stage_dev_formula_add"] });
  assert.equal(WorkerPlacement.reusableWorker(registry, "device-one", stage, { isPreviousAssignmentReleased: true }), undefined);
  assert.equal(WorkerPlacement.reusableWorker(registry, "device-absent", stage, { isPreviousAssignmentReleased: true }), undefined);
});

test("each shard of a repeating pipeline returns to the device that ran that same shard", () => {
  const resolver = new StagePolicyResolver(new PipelineRegistry(builtinPipelineSpecifications), 15_000);
  const store = new TaskStore();
  const task = createTask(store, { taskType: "task_type_llm_qwen3_0_6b_sharded", input: "hello" });

  // One round of the three shards, spread over two devices.
  const placements: [StageName, string][] = [
    ["stage_llm_qwen3_0_6b_shard1of3", "device-a"],
    ["stage_llm_qwen3_0_6b_shard2of3", "device-b"],
    ["stage_llm_qwen3_0_6b_shard3of3", "device-b"],
  ];
  let current = task;
  for (const [stage, deviceId] of placements) {
    store.assign(current.taskId, deviceId, stage, { tensors: {} });
    current = store.addStage(current.taskId, { name: stage, value: { text: "The", done: false } });
  }
  assert.deepEqual(current.stageWorkerDeviceIds, {
    stage_llm_qwen3_0_6b_shard1of3: "device-a",
    stage_llm_qwen3_0_6b_shard2of3: "device-b",
    stage_llm_qwen3_0_6b_shard3of3: "device-b",
  });

  // The second round starts again at the first shard. The device holding the key-value cache
  // for that shard is the device that ran it in the previous round, not the device that
  // happened to finish last.
  const upcoming = TaskStore.nextStage(current)!;
  assert.equal(upcoming, "stage_llm_qwen3_0_6b_shard1of3");
  assert.equal(WorkerPlacement.preferredWorkerDeviceId(current, upcoming, resolver.resolve(current, upcoming), "device-b"), "device-a");

  // A stage of this task that has never run yet falls back to the device that just finished,
  // which is where a hand-off from the previous shard is held.
  const withoutThirdShard = { ...current, stageWorkerDeviceIds: { stage_llm_qwen3_0_6b_shard1of3: "device-a" } };
  assert.equal(WorkerPlacement.preferredWorkerDeviceId(withoutThirdShard, "stage_llm_qwen3_0_6b_shard3of3", resolver.resolve(current, "stage_llm_qwen3_0_6b_shard3of3"), "device-b"), "device-b");
});

test("a stage that keeps no state is pinned to no device at all", () => {
  const resolver = new StagePolicyResolver(new PipelineRegistry(builtinPipelineSpecifications), 15_000);
  const store = new TaskStore();
  const task = createTask(store, { taskType: "task_type_dev_formula", input: 5 });
  store.assign(task.taskId, "device-one", "stage_dev_formula_multiply", 5);
  const afterMultiply = store.addStage(task.taskId, { name: "stage_dev_formula_multiply", value: 10 });

  // The device is still recorded, because recording it costs nothing and does not depend on
  // the stage. What decides the placement is the stage's own policy, which says the next stage
  // is preferably moved to a different device.
  assert.deepEqual(afterMultiply.stageWorkerDeviceIds, { stage_dev_formula_multiply: "device-one" });
  const policy = resolver.resolve(afterMultiply, "stage_dev_formula_add");
  assert.equal(WorkerPlacement.preferredWorkerDeviceId(afterMultiply, "stage_dev_formula_add", policy, "device-one"), undefined);
});

test("resets the retry budget after each successful LLM stage", () => {
  const store = new TaskStore();
  const task = createTask(store, { taskType: "task_type_llm_qwen3_0_6b_sharded", input: "hello" });
  let current = store.assign(task.taskId, "worker-1", "stage_llm_qwen3_0_6b_shard1of3", { text: "hello" });
  assert.equal(current.assignment?.attempt, 1);
  current = store.addStage(current.taskId, { name: "stage_llm_qwen3_0_6b_shard1of3", value: { tensors: {} } });
  assert.equal(current.currentStageAttempts, 0);
  current = store.assign(current.taskId, "worker-2", "stage_llm_qwen3_0_6b_shard2of3", { tensors: {} });
  assert.equal(current.assignment?.attempt, 1);
  current = store.addStage(current.taskId, { name: "stage_llm_qwen3_0_6b_shard2of3", value: { tensors: {} } });
  current = store.assign(current.taskId, "worker-3", "stage_llm_qwen3_0_6b_shard3of3", { tensors: {} });
  current = store.addStage(current.taskId, { name: "stage_llm_qwen3_0_6b_shard3of3", value: { text: "The", done: false } });
  current = store.assign(current.taskId, "worker-1", "stage_llm_qwen3_0_6b_shard1of3", { text: "The", done: false });
  assert.equal(current.assignment?.attempt, 1);
});

test("tells a device joining apart from a change to its description, its activity, and its liveness", () => {
  const registry = new DeviceRegistry();
  const first = registry.add(worker("one", ["stage_dev_formula_multiply"]));
  assert.equal(first.kind, "joined");

  const stored = registry.get("one")!;
  const touched = registry.add({ ...stored, lastSeenAt: "2026-01-01T00:00:05.000Z" });
  const busy = registry.add({ ...registry.get("one")!, activeAssignments: 1, lastSeenAt: "2026-01-01T00:00:06.000Z" });
  const renamed = registry.add({ ...registry.get("one")!, name: "worker-renamed" });
  const restaged = registry.add({ ...registry.get("one")!, stageNames: ["stage_dev_formula_add"] });

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
  const task = createTask(store, { taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-1");
  const assigned = store.assign(task.taskId, "worker-1", "stage_dev_formula_multiply", 5);
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
  const task = createTask(store, { taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-1");
  const assigned = store.assign(task.taskId, "worker-1", "stage_dev_formula_multiply", 5, undefined, 60_000);
  assert.ok(Date.parse(assigned.assignment!.leaseUntil) - Date.now() > 30_000);
});

test("stage settings come from the pipeline specification, and language-model shards keep their worker", () => {
  const registry = new PipelineRegistry(builtinPipelineSpecifications);
  registry.add({
    pipelineId: "dev_formula", version: 2, taskType: "task_type_dev_formula",
    stages: [
      { name: "stage_dev_formula_multiply", computation: "dev_formula_multiply", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json", leaseMs: 9_000, prefersSameWorkerOnRetry: true },
      { name: "stage_dev_formula_add", computation: "dev_formula_add", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" },
    ],
  });
  const resolver = new StagePolicyResolver(registry, 2_000);
  const store = new TaskStore(undefined, 30_000, 2_000);

  const specified = store.create({ taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-1", undefined, { pipelineId: "dev_formula", pipelineVersion: 2 });
  assert.deepEqual(resolver.resolve(specified, "stage_dev_formula_multiply"), { leaseMs: 9_000, prefersSameWorkerOnRetry: true });
  // A stage that states no lease of its own falls back to the gateway's --lease-ms default.
  assert.deepEqual(resolver.resolve(specified, "stage_dev_formula_add"), { leaseMs: 2_000, prefersSameWorkerOnRetry: false });

  // The language-model pipeline is an ordinary specification like any other. Its shards
  // state that they keep their worker, so a retry does not throw away the key-value cache.
  const llm = store.create({ taskType: "task_type_llm_qwen3_0_6b_sharded", input: "hello" }, "consumer-1", "request-2", undefined, { pipelineId: "llm_qwen3_0_6b_sharded", pipelineVersion: 1 });
  assert.deepEqual(resolver.resolve(llm, "stage_llm_qwen3_0_6b_shard1of3"), { leaseMs: 2_000, prefersSameWorkerOnRetry: true });
  // A stage the task's own pipeline does not list falls back to the defaults.
  assert.deepEqual(resolver.resolve(llm, "stage_dev_formula_multiply"), { leaseMs: 2_000, prefersSameWorkerOnRetry: false });
});

test("a pipeline file may introduce a stage name that appears nowhere in the source", () => {
  const registry = new PipelineRegistry(builtinPipelineSpecifications);
  registry.add({
    pipelineId: "invented", version: 7, taskType: "task_type_dev_formula", stages: [
      { name: "stage_invented_first", computation: "dev_formula_multiply", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" },
      { name: "stage_invented_second", computation: "dev_formula_add", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" },
    ],
  });

  assert.equal(registry.definesStage("stage_invented_first"), true);
  assert.equal(registry.definesStage("stage_never_defined"), false);
  assert.ok(registry.stageNames().includes("stage_invented_second"));

  // A higher version wins, so the invented pipeline is what a formula task now runs.
  const store = new TaskStore();
  const pipeline = registry.select({ taskType: "task_type_dev_formula", input: 5 })!;
  assert.equal(pipeline.pipelineId, "invented");
  const task = store.create({ taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-1", undefined, {
    pipelineId: pipeline.pipelineId, pipelineVersion: pipeline.version, pipelineStages: pipeline.stages.map((stage) => stage.name),
  });
  assert.equal(TaskStore.nextStage(task), "stage_invented_first");
  const afterFirst = store.addStage(task.taskId, { name: "stage_invented_first", value: 10 });
  assert.equal(TaskStore.nextStage(afterFirst), "stage_invented_second");
  const afterSecond = store.addStage(task.taskId, { name: "stage_invented_second", value: 17 });
  assert.equal(TaskStore.nextStage(afterSecond), undefined);
});

test("a repeating pipeline runs its stages again until a result reports it is done", () => {
  const store = new TaskStore();
  const registry = new PipelineRegistry(builtinPipelineSpecifications);
  registry.add({
    pipelineId: "two_step_loop", version: 1, taskType: "task_type_llm_qwen3_0_6b_sharded", repeatsUntilDone: true, stages: [
      { name: "stage_loop_first", computation: "llm_qwen3_0_6b_shard", inputSchemaId: "llm@1", outputSchemaId: "llm@1", encoding: "inline-json" },
      { name: "stage_loop_second", computation: "llm_qwen3_0_6b_shard", inputSchemaId: "llm@1", outputSchemaId: "llm@1", encoding: "inline-json" },
    ],
  });
  const pipeline = registry.get("two_step_loop", 1)!;
  let current = store.create({ taskType: "task_type_llm_qwen3_0_6b_sharded", input: "hello" }, "consumer-1", "request-1", undefined, {
    pipelineId: pipeline.pipelineId, pipelineVersion: pipeline.version, pipelineStages: pipeline.stages.map((stage) => stage.name), pipelineRepeatsUntilDone: true,
  });

  assert.equal(TaskStore.nextStage(current), "stage_loop_first");
  current = store.addStage(current.taskId, { name: "stage_loop_first", value: { tensors: {} } });
  assert.equal(TaskStore.nextStage(current), "stage_loop_second");
  // The cycle ended without reporting it is done, so the pipeline starts again.
  current = store.addStage(current.taskId, { name: "stage_loop_second", value: { text: "The", done: false } });
  assert.equal(TaskStore.nextStage(current), "stage_loop_first");

  current = store.addStage(current.taskId, { name: "stage_loop_first", value: { tensors: {} } });
  current = store.addStage(current.taskId, { name: "stage_loop_second", value: { text: "The capital", done: true } });
  assert.equal(TaskStore.nextStage(current), undefined);
});

test("a restored task that carries no pipeline is failed rather than left stuck", () => {
  const directory = mkdtempSync(join(tmpdir(), "webai-task-store-legacy-"));
  const stateFile = join(directory, "state.json");
  try {
    const first = new TaskStore(undefined, 30_000, 15_000, stateFile);
    // A task created without a pipeline, the way an earlier gateway wrote them.
    const stranded = first.create({ taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-1");
    const finished = first.create({ taskType: "task_type_dev_formula", input: 5 }, "consumer-1", "request-2");
    first.update(finished.taskId, { state: "completed", result: 17 });

    const second = new TaskStore(undefined, 30_000, 15_000, stateFile);
    assert.equal(second.get(stranded.taskId)?.state, "failed");
    assert.equal(second.get(stranded.taskId)?.error, "NO_PIPELINE_ON_RESTORED_TASK");
    // A task that already finished is left exactly as it was.
    assert.equal(second.get(finished.taskId)?.state, "completed");
    assert.equal(second.get(finished.taskId)?.result, 17);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("diagnostic reporting is capped per device over a rolling window", () => {
  const limiter = new DiagnosticsRateLimiter(10, 1_000);
  const start = 1_000_000;

  assert.equal(limiter.accept("device-a", 6, start).isAccepted, true);
  const second = limiter.accept("device-a", 4, start + 100);
  assert.equal(second.isAccepted, true);
  assert.equal(second.remaining, 0);

  // The allowance is spent, so the next report is refused rather than partly recorded.
  const refused = limiter.accept("device-a", 1, start + 200);
  assert.equal(refused.isAccepted, false);
  assert.ok(refused.retryAfterMs > 0);

  // One device's traffic never spends another device's allowance.
  assert.equal(limiter.accept("device-b", 10, start + 200).isAccepted, true);

  // The window rolls: once the earliest entries age out, that much allowance returns.
  assert.equal(limiter.accept("device-a", 6, start + 1_050).isAccepted, true);
  assert.equal(limiter.accept("device-a", 5, start + 1_050).isAccepted, false);

  // A disconnected device's allowance is released with it.
  limiter.forget("device-a");
  assert.equal(limiter.accept("device-a", 10, start + 1_060).isAccepted, true);
});

test("two different credentials never become the same principal", () => {
  // The principal used to be the first twelve characters of the token, so any two tokens
  // sharing a prefix collided into one principal and shared its task quota.
  const collidingPrefixes = ["development-token", "development-token-two", "development-tokenXYZ", "development-"];
  const principals = collidingPrefixes.map((token) => SessionRegistry.principalFor(token));
  assert.equal(new Set(principals).size, collidingPrefixes.length);

  // The same credential always resolves to the same principal, so a task submitted before a
  // renewal and one submitted after count against the same quota.
  assert.equal(SessionRegistry.principalFor("development-token"), SessionRegistry.principalFor("development-token"));

  // No part of the credential is readable in the principal, which is recorded on every task
  // and written to every log file.
  for (const [index, token] of collidingPrefixes.entries()) assert.equal(principals[index]?.includes(token), false);
});

test("an advertised session expiry is actually enforced, and survives re-authenticating", () => {
  const registry = new SessionRegistry(1_000);
  const start = 5_000_000;

  const session = registry.open("device-a", "development-token", start);
  assert.equal(session.expiresAt, start + 1_000);
  assert.equal(registry.active("device-a", start + 999)?.principal, session.principal);

  // Once the advertised moment passes the session is gone, rather than lasting as long as
  // the connection stays open.
  assert.equal(registry.active("device-a", start + 1_000), undefined);
  assert.equal(registry.active("device-a", start + 5_000), undefined);

  // Authenticating again on the same connection opens a fresh session.
  const renewed = registry.open("device-a", "development-token", start + 5_000);
  assert.equal(renewed.expiresAt, start + 6_000);
  assert.equal(registry.active("device-a", start + 5_500)?.principal, renewed.principal);

  // One connection's expiry never affects another's.
  registry.open("device-b", "development-token", start + 5_000);
  registry.close("device-a");
  assert.equal(registry.active("device-a", start + 5_500), undefined);
  assert.notEqual(registry.active("device-b", start + 5_500), undefined);
});
