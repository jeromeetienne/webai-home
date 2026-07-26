import assert from "node:assert/strict";
import test from "node:test";
import { DeviceRegistry } from "../src/registry.js";
import { nextStage, TaskStore } from "../src/tasks.js";

const volunteer = (deviceId: string, capabilities: ("multiply" | "add")[] = ["multiply", "add"]) => ({
  deviceId,
  name: `volunteer-${deviceId}`,
  role: "volunteer" as const,
  capabilities,
  connectedAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
});

test("finds volunteers by capability and excludes devices", () => {
  const registry = new DeviceRegistry();
  registry.add(volunteer("one", ["multiply"]));
  registry.add(volunteer("two", ["add"]));

  assert.equal(registry.findVolunteer("multiply")?.deviceId, "one");
  assert.equal(registry.findVolunteer("multiply", ["one"]), undefined);
  assert.equal(registry.findByName("volunteer-two", "volunteer")?.deviceId, "two");
});

test("creates tasks and advances through both stages", () => {
  const store = new TaskStore();
  const task = store.create({ input: 5 });

  assert.equal(task.state, "queued");
  assert.equal(nextStage(task), "multiply");

  const afterMultiply = store.addStage(task.taskId, { name: "multiply", value: 10 });
  assert.equal(nextStage(afterMultiply), "add");

  const afterAdd = store.addStage(task.taskId, { name: "add", value: 17 });
  const completed = store.update(afterAdd.taskId, { state: "completed", result: 17 });
  assert.equal(nextStage(completed), undefined);
  assert.equal(store.get(task.taskId)?.result, 17);
});
