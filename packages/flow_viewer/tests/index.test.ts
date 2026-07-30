import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { calculateStatistics } from "../public/src/statistics.js";
import { TimelineModel } from "../public/src/timeline_model.js";
import { LogEntryParser } from "../public/src/log_entry_parser.js";
import type { LogEntry } from "@webai/protocol/message_logger";
import type { TimelineEvent } from "../public/src/types.js";

const entry = (timestamp: string, direction: "received" | "sent", messageType: string, payload: unknown, bytes: number): LogEntry => ({
	timestamp, direction, counterpart: { role: "worker", deviceId: "worker-1" }, messageType, payload, payloadBytes: bytes, messageBytes: bytes + 10,
});

const event = (index: number, logEntry: LogEntry, taskId: string | undefined, fromActorId: string, toActorId: string): TimelineEvent => ({
	index, timestampMs: Date.parse(logEntry.timestamp), logEntry, direction: logEntry.direction, fromActorId, toActorId,
	messageType: logEntry.messageType, summary: logEntry.messageType, detail: undefined, taskId, answersMessageType: undefined, category: "task",
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

test("renders request and assignment identities from the issue 37 formula fixture", () => {
	const fixturePath = join(process.cwd(), "fixtures/issue-37-formula.log_entry.jsonl");
	const entries = readFileSync(fixturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LogEntry);
	const model = TimelineModel.build([{ id: "issue-37", label: "Issue 37", entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	assert.equal(model.events.some((item) => item.summary.includes("request formula-request-1")), true);
	assert.equal(model.events.some((item) => item.summary.includes("assignment assignment-multiply-1, attempt 1")), true);
	assert.equal(model.events.some((item) => item.summary.includes("to completed")), true);
});

test("summarises a task.submit whose input was redacted by the message logger", () => {
	const entries: LogEntry[] = [
		{ timestamp: "2026-01-01T00:00:00.000Z", direction: "received", counterpart: { role: "consumer", deviceId: "device-1" }, messageType: "task.submit", payload: { type: "task.submit", requestId: "request-1", input: "[redacted]" } },
		{ timestamp: "2026-01-01T00:00:01.000Z", direction: "received", counterpart: { role: "consumer", deviceId: "device-1" }, messageType: "task.submit", payload: { type: "task.submit", requestId: "request-2", input: { taskType: "task_type_llm_qwen3_0_6b_sharded", input: "[redacted]" } } },
	];
	const model = TimelineModel.build([{ id: "run", label: "Run", entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	assert.equal(model.events.some((item) => item.summary.includes("undefined")), false);
	assert.equal(model.events[0].summary, "submits a task: [redacted] (request request-1)");
	assert.equal(model.events[1].summary, "submits a task_type_llm_qwen3_0_6b_sharded: [redacted] (request request-2)");
});

test("labels each animated packet with a short detail that fits inside the diagram", () => {
	const entries: LogEntry[] = [
		{ timestamp: "2026-01-01T00:00:00.000Z", direction: "received", counterpart: { role: "consumer", deviceId: "device-1" }, messageType: "task.submit", payload: { type: "task.submit", requestId: "101d72ba-6a97-4d74-b5c9-beba0c603132", input: "[redacted]" } },
		{ timestamp: "2026-01-01T00:00:01.000Z", direction: "sent", counterpart: { role: "worker", deviceId: "device-2" }, messageType: "stage.assign", payload: { type: "stage.assign", taskId: "task-936a3880-2bad-47e9-b776-4ec985895d50", assignmentId: "assignment-50badfe0-1084-4d48-91b5-6cb2369fe601", attempt: 1, stage: "stage_dev_formula_multiply", value: "[redacted]" } },
		{ timestamp: "2026-01-01T00:00:02.000Z", direction: "sent", counterpart: { role: "consumer", deviceId: "device-1" }, messageType: "task.updated", payload: { type: "task.updated", task: { taskId: "task-936a3880-2bad-47e9-b776-4ec985895d50", state: "running", revision: 4 } } },
		{ timestamp: "2026-01-01T00:00:03.000Z", direction: "sent", counterpart: { role: "consumer", deviceId: "device-1" }, messageType: "error", payload: { type: "error", message: "the worker relinquished the assignment before the lease expired" } },
	];
	const model = TimelineModel.build([{ id: "run", label: "Run", entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	assert.deepEqual(model.events.map((item) => item.detail), ["request 101d72ba", "stage_dev_formula_multiply", "now running", "the worker relinquished the…"]);
	assert.equal(model.events.every((item) => (item.detail ?? "").length <= 28), true);
});

test("hides connection and device-membership traffic with the default filters", () => {
	const entries: LogEntry[] = [
		{ timestamp: "2026-01-01T00:00:00.000Z", direction: "received", counterpart: { role: "unknown", deviceId: "device-1" }, messageType: "authenticate", payload: { type: "authenticate" } },
		{ timestamp: "2026-01-01T00:00:00.001Z", direction: "sent", counterpart: { role: "unknown", deviceId: "device-1" }, messageType: "authenticated", payload: { type: "authenticated" } },
		{ timestamp: "2026-01-01T00:00:00.002Z", direction: "sent", counterpart: { role: "unknown", deviceId: "device-1" }, messageType: "device.joined", payload: { type: "device.joined" } },
	];
	const model = TimelineModel.build([{ id: "run", label: "Run", entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: false, showSignaling: false });
	assert.deepEqual(model.actors, []);
	assert.deepEqual(model.events, []);
});


test("matches each answer to its own request by identifier, even with two submissions in flight", () => {
	const consumer = { role: "consumer", deviceId: "consumer-1" };
	const entries: LogEntry[] = [
		{ timestamp: "2026-01-01T00:00:00.000Z", direction: "received", counterpart: consumer, messageType: "task.submit", payload: { type: "task.submit", requestId: "request-a" }, messageId: "message-a" },
		{ timestamp: "2026-01-01T00:00:00.100Z", direction: "received", counterpart: consumer, messageType: "task.submit", payload: { type: "task.submit", requestId: "request-b" }, messageId: "message-b" },
		// The answers come back in the opposite order, which the old forward scan got wrong.
		{ timestamp: "2026-01-01T00:00:00.200Z", direction: "sent", counterpart: consumer, messageType: "task.accepted", payload: { type: "task.accepted", task: { taskId: "task-b" } }, messageId: "message-c", inReplyTo: "message-b" },
		{ timestamp: "2026-01-01T00:00:00.300Z", direction: "sent", counterpart: consumer, messageType: "task.accepted", payload: { type: "task.accepted", task: { taskId: "task-a" } }, messageId: "message-d", inReplyTo: "message-a" },
	];

	const model = TimelineModel.build([{ id: "run", label: "Run", entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	assert.equal(model.events[0].taskId, "task-a");
	assert.equal(model.events[1].taskId, "task-b");
	// An answer names the request it answers; a message the gateway pushed on its own does not.
	assert.equal(model.events[2].answersMessageType, "task.submit");
	assert.equal(model.events[0].answersMessageType, undefined);
});

test("still matches a submission to its answer in a log recorded before the identifiers existed", () => {
	const consumer = { role: "consumer", deviceId: "consumer-1" };
	const entries: LogEntry[] = [
		{ timestamp: "2026-01-01T00:00:00.000Z", direction: "received", counterpart: consumer, messageType: "task.submit", payload: { type: "task.submit", requestId: "request-a" } },
		{ timestamp: "2026-01-01T00:00:00.200Z", direction: "sent", counterpart: consumer, messageType: "task.accepted", payload: { type: "task.accepted", task: { taskId: "task-a" } } },
	];

	const model = TimelineModel.build([{ id: "run", label: "Run", entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	assert.equal(model.events[0].taskId, "task-a");
	assert.equal(model.events[1].answersMessageType, undefined);
});

test("keeps the wrapper fields when parsing a log line, and tolerates a line without them", () => {
	const withWrapper = '{"timestamp":"2026-01-01T00:00:00.000Z","direction":"sent","counterpart":{"role":"consumer","deviceId":"device-1"},"messageType":"task.accepted","payload":{},"messageId":"message-1","inReplyTo":"message-0","protocolVersion":1}';
	const withoutWrapper = '{"timestamp":"2026-01-01T00:00:01.000Z","direction":"sent","counterpart":{"role":"consumer","deviceId":"device-1"},"messageType":"task.accepted","payload":{}}';

	const { entries, lineErrors } = LogEntryParser.parseJsonl(`${withWrapper}\n${withoutWrapper}`);
	assert.deepEqual(lineErrors, []);
	assert.equal(entries[0].messageId, "message-1");
	assert.equal(entries[0].inReplyTo, "message-0");
	assert.equal(entries[0].protocolVersion, 1);
	// A log recorded before the wrapper existed still parses; it simply carries none of them.
	assert.equal(entries[1].messageId, undefined);
	assert.equal(entries[1].inReplyTo, undefined);
});
