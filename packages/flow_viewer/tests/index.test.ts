import assert from "node:assert/strict";
import test from "node:test";
import { calculateStatistics } from "../public/src/statistics.js";
import type { LogEntry } from "@webai/protocol/message_logger";
import type { TimelineEvent } from "../public/src/types.js";

const entry = (timestamp: string, direction: "received" | "sent", messageType: string, payload: unknown, bytes: number): LogEntry => ({
	timestamp, direction, counterpart: { role: "worker", deviceId: "worker-1" }, messageType, payload, payloadBytes: bytes, messageBytes: bytes + 10,
});

const event = (index: number, logEntry: LogEntry, taskId: string | undefined, fromActorId: string, toActorId: string): TimelineEvent => ({
	index, timestampMs: Date.parse(logEntry.timestamp), logEntry, direction: logEntry.direction, fromActorId, toActorId,
	messageType: logEntry.messageType, summary: logEntry.messageType, taskId, category: "task",
});

test("calculates measured bytes, duplicate data, groups, and stage latency", () => {
	const entries = [
		entry("2026-01-01T00:00:00.000Z", "sent", "stage.assign", { type: "stage.assign", taskId: "task-1", stage: "multiply", value: 2 }, 20),
		entry("2026-01-01T00:00:00.125Z", "received", "stage.result", { type: "stage.result", taskId: "task-1", stage: "multiply", value: 2 }, 20),
		entry("2026-01-01T00:00:00.250Z", "received", "stage.result", { type: "stage.result", taskId: "task-1", stage: "multiply", value: 2 }, 20),
	];
	const events = entries.map((item, index) => event(index, item, "task-1", "gateway:run", "worker:worker-1"));
	const report = calculateStatistics([{ id: "run", label: "Run", entries }], events, { fromMs: 0, toMs: Date.parse("2026-01-01T00:01:00.000Z") });
	assert.equal(report.total.messageCount, 3);
	assert.equal(report.total.payloadBytes, 60);
	assert.equal(report.total.duplicateBytes, 20);
	assert.equal(report.total.measuredMessages, 3);
	assert.equal(report.byStage.get("multiply")?.messageCount, 3);
	assert.equal(report.total.latencyMs, 125);
});

test("marks old entries as estimates", () => {
	const item: LogEntry = { timestamp: "2026-01-01T00:00:00.000Z", direction: "sent", counterpart: { role: "consumer" }, messageType: "task.accepted", payload: { type: "task.accepted" } };
	const report = calculateStatistics([{ id: "run", label: "Run", entries: [item] }], [event(0, item, undefined, "gateway:run", "consumer:c")], { fromMs: 0, toMs: Date.now() });
	assert.equal(report.total.measuredMessages, 0);
	assert.equal(report.total.estimatedMessages, 1);
});
