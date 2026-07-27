// node imports
import assert from "node:assert/strict";
import test from "node:test";

// local imports
import { DeviceRegistry } from "../src/libs/device_registry.js";
import { TaskStore } from "../src/libs/task_store.js";

const volunteer = (deviceId: string, stageNames: ("stage_formula_multiply" | "stage_formula_add")[] = ["stage_formula_multiply", "stage_formula_add"]) => ({
  deviceId,
  name: `volunteer-${deviceId}`,
  deviceRole: "volunteer" as const,
  stageNames,
  connectedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
});

test("finds volunteers by capability and excludes devices", () => {
  const registry = new DeviceRegistry();
  registry.add(volunteer("one", ["stage_formula_multiply"]));
  registry.add(volunteer("two", ["stage_formula_add"]));

  assert.equal(registry.findVolunteer("stage_formula_multiply")?.deviceId, "one");
  assert.equal(registry.findVolunteer("stage_formula_multiply", ["one"]), undefined);
  assert.equal(registry.findByName("volunteer-two", "volunteer")?.deviceId, "two");
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
