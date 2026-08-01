import Assert from 'node:assert/strict';
import Fs from 'node:fs';
import Path from 'node:path';
import Test from 'node:test';
import { Statistics } from '../web/src/statistics.js';
import { TimelineModel } from '../web/src/timeline_model.js';
import { LogEntryParser } from '../web/src/log_entry_parser.js';
import type { LogEntry } from '@webai/protocol/message_logger';
import type { TimelineEvent } from '../web/src/types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for the flow_viewer package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const entry = (timestamp: string, direction: 'received' | 'sent', messageType: string, messagePayload: unknown, bytes: number): LogEntry => ({
	timestamp, direction, counterpart: { role: 'worker', deviceId: 'worker-1' }, messageType, messagePayload, messagePayloadBytes: bytes, messageBytes: bytes + 10,
});

const event = (index: number, logEntry: LogEntry, taskId: string | undefined, fromActorId: string, toActorId: string): TimelineEvent => ({
	index, timestampMs: Date.parse(logEntry.timestamp), logEntry, direction: logEntry.direction, fromActorId, toActorId,
	messageType: logEntry.messageType, summary: logEntry.messageType, detail: undefined, taskId, answersMessageType: undefined, category: 'task',
});

Test('calculates measured bytes, duplicate data, groups, and stage latency', () => {
	const entries = [
		entry('2026-01-01T00:00:00.000Z', 'sent', 'stage.assign', { type: 'stage.assign', taskId: 'task-1', stage: 'multiply', value: 2 }, 20),
		entry('2026-01-01T00:00:00.125Z', 'received', 'stage.result', { type: 'stage.result', taskId: 'task-1', stage: 'multiply', value: 2 }, 20),
		entry('2026-01-01T00:00:00.250Z', 'received', 'stage.result', { type: 'stage.result', taskId: 'task-1', stage: 'multiply', value: 2 }, 20),
	];
	const events = entries.map((item, index) => event(index, item, 'task-1', 'gateway:run', 'worker:worker-1'));
	const report = Statistics.calculateStatistics([{ id: 'run', label: 'Run', entries }], events, { fromMs: 0, toMs: Date.parse('2026-01-01T00:01:00.000Z') });
	Assert.equal(report.total.messageCount, 3);
	Assert.equal(report.total.messagePayloadBytes, 60);
	Assert.equal(report.total.duplicateBytes, 20);
	Assert.equal(report.total.measuredMessages, 3);
	Assert.equal(report.byStage.get('multiply')?.messageCount, 3);
	Assert.equal(report.total.latencyMs, 125);
});

Test('marks old entries as estimates', () => {
	const item: LogEntry = { timestamp: '2026-01-01T00:00:00.000Z', direction: 'sent', counterpart: { role: 'consumer' }, messageType: 'task.accepted', messagePayload: { type: 'task.accepted' } };
	const report = Statistics.calculateStatistics([{ id: 'run', label: 'Run', entries: [item] }], [event(0, item, undefined, 'gateway:run', 'consumer:c')], { fromMs: 0, toMs: Date.now() });
	Assert.equal(report.total.measuredMessages, 0);
	Assert.equal(report.total.estimatedMessages, 1);
});

Test('renders request and assignment identities from the issue 37 formula fixture', () => {
	const fixturePath = Path.join(process.cwd(), 'fixtures/issue-37-formula.log_entry.jsonl');
	const entries = Fs.readFileSync(fixturePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LogEntry);
	const model = TimelineModel.build([{ id: 'issue-37', label: 'Issue 37', entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	Assert.equal(model.events.some((item) => item.summary.includes('request formula-request-1')), true);
	Assert.equal(model.events.some((item) => item.summary.includes('assignment assignment-multiply-1, attempt 1')), true);
	Assert.equal(model.events.some((item) => item.summary.includes('to completed')), true);
});

Test('summarises a task.submit whose input was redacted by the message logger', () => {
	const entries: LogEntry[] = [
		{ timestamp: '2026-01-01T00:00:00.000Z', direction: 'received', counterpart: { role: 'consumer', deviceId: 'device-1' }, messageType: 'task.submit', messagePayload: { type: 'task.submit', taskRequestId: 'request-1', input: '[redacted]' } },
		{ timestamp: '2026-01-01T00:00:01.000Z', direction: 'received', counterpart: { role: 'consumer', deviceId: 'device-1' }, messageType: 'task.submit', messagePayload: { type: 'task.submit', taskRequestId: 'request-2', input: { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: '[redacted]' } } },
	];
	const model = TimelineModel.build([{ id: 'run', label: 'Run', entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	Assert.equal(model.events.some((item) => item.summary.includes('undefined')), false);
	Assert.equal(model.events[0].summary, 'submits a task: [redacted] (request request-1)');
	Assert.equal(model.events[1].summary, 'submits a task_type_llm_qwen3_0_6b_sharded: [redacted] (request request-2)');
});

Test('labels each animated packet with a short detail that fits inside the diagram', () => {
	const entries: LogEntry[] = [
		{ timestamp: '2026-01-01T00:00:00.000Z', direction: 'received', counterpart: { role: 'consumer', deviceId: 'device-1' }, messageType: 'task.submit', messagePayload: { type: 'task.submit', taskRequestId: '101d72ba-6a97-4d74-b5c9-beba0c603132', input: '[redacted]' } },
		{ timestamp: '2026-01-01T00:00:01.000Z', direction: 'sent', counterpart: { role: 'worker', deviceId: 'device-2' }, messageType: 'stage.assign', messagePayload: { type: 'stage.assign', taskId: 'task-936a3880-2bad-47e9-b776-4ec985895d50', stageAssignmentId: 'assignment-50badfe0-1084-4d48-91b5-6cb2369fe601', attempt: 1, stage: 'stage_dev_formula_multiply', value: '[redacted]' } },
		{ timestamp: '2026-01-01T00:00:02.000Z', direction: 'sent', counterpart: { role: 'consumer', deviceId: 'device-1' }, messageType: 'task.updated', messagePayload: { type: 'task.updated', task: { taskId: 'task-936a3880-2bad-47e9-b776-4ec985895d50', state: 'running', taskRevision: 4 } } },
		{ timestamp: '2026-01-01T00:00:03.000Z', direction: 'sent', counterpart: { role: 'consumer', deviceId: 'device-1' }, messageType: 'error', messagePayload: { type: 'error', message: 'the worker relinquished the assignment before the lease expired' } },
	];
	const model = TimelineModel.build([{ id: 'run', label: 'Run', entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	Assert.deepEqual(model.events.map((item) => item.detail), ['request 101d72ba', 'stage_dev_formula_multiply', 'now running', 'the worker relinquished the…']);
	Assert.equal(model.events.every((item) => (item.detail ?? '').length <= 28), true);
});

Test('hides connection and device-membership traffic with the default filters', () => {
	const entries: LogEntry[] = [
		{ timestamp: '2026-01-01T00:00:00.000Z', direction: 'received', counterpart: { role: 'unknown', deviceId: 'device-1' }, messageType: 'deviceAuthenticate', messagePayload: { type: 'deviceAuthenticate' } },
		{ timestamp: '2026-01-01T00:00:00.001Z', direction: 'sent', counterpart: { role: 'unknown', deviceId: 'device-1' }, messageType: 'deviceAuthenticated', messagePayload: { type: 'deviceAuthenticated' } },
		{ timestamp: '2026-01-01T00:00:00.002Z', direction: 'sent', counterpart: { role: 'unknown', deviceId: 'device-1' }, messageType: 'device.joined', messagePayload: { type: 'device.joined' } },
	];
	const model = TimelineModel.build([{ id: 'run', label: 'Run', entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: false, showSignaling: false });
	Assert.deepEqual(model.actors, []);
	Assert.deepEqual(model.events, []);
});


Test('matches each answer to its own request by identifier, even with two submissions in flight', () => {
	const consumer = { role: 'consumer', deviceId: 'consumer-1' };
	const entries: LogEntry[] = [
		{ timestamp: '2026-01-01T00:00:00.000Z', direction: 'received', counterpart: consumer, messageType: 'task.submit', messagePayload: { type: 'task.submit', taskRequestId: 'request-a' }, messageId: 'message-a' },
		{ timestamp: '2026-01-01T00:00:00.100Z', direction: 'received', counterpart: consumer, messageType: 'task.submit', messagePayload: { type: 'task.submit', taskRequestId: 'request-b' }, messageId: 'message-b' },
		// The answers come back in the opposite order, which the old forward scan got wrong.
		{ timestamp: '2026-01-01T00:00:00.200Z', direction: 'sent', counterpart: consumer, messageType: 'task.accepted', messagePayload: { type: 'task.accepted', task: { taskId: 'task-b' } }, messageId: 'message-c', inReplyToMessageId: 'message-b' },
		{ timestamp: '2026-01-01T00:00:00.300Z', direction: 'sent', counterpart: consumer, messageType: 'task.accepted', messagePayload: { type: 'task.accepted', task: { taskId: 'task-a' } }, messageId: 'message-d', inReplyToMessageId: 'message-a' },
	];

	const model = TimelineModel.build([{ id: 'run', label: 'Run', entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	Assert.equal(model.events[0].taskId, 'task-a');
	Assert.equal(model.events[1].taskId, 'task-b');
	// An answer names the request it answers; a message the gateway pushed on its own does not.
	Assert.equal(model.events[2].answersMessageType, 'task.submit');
	Assert.equal(model.events[0].answersMessageType, undefined);
});

Test('still matches a submission to its answer in a log recorded before the identifiers existed', () => {
	const consumer = { role: 'consumer', deviceId: 'consumer-1' };
	const entries: LogEntry[] = [
		{ timestamp: '2026-01-01T00:00:00.000Z', direction: 'received', counterpart: consumer, messageType: 'task.submit', messagePayload: { type: 'task.submit', taskRequestId: 'request-a' } },
		{ timestamp: '2026-01-01T00:00:00.200Z', direction: 'sent', counterpart: consumer, messageType: 'task.accepted', messagePayload: { type: 'task.accepted', task: { taskId: 'task-a' } } },
	];

	const model = TimelineModel.build([{ id: 'run', label: 'Run', entries }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }, { showChatter: true, showSignaling: true });
	Assert.equal(model.events[0].taskId, 'task-a');
	Assert.equal(model.events[1].answersMessageType, undefined);
});

Test('keeps the wrapper fields when parsing a log line, and tolerates a line without them', () => {
	const withWrapper = '{"timestamp":"2026-01-01T00:00:00.000Z","direction":"sent","counterpart":{"role":"consumer","deviceId":"device-1"},"messageType":"task.accepted","messagePayload":{},"messageId":"message-1","inReplyToMessageId":"message-0","protocolVersion":1}';
	const withoutWrapper = '{"timestamp":"2026-01-01T00:00:01.000Z","direction":"sent","counterpart":{"role":"consumer","deviceId":"device-1"},"messageType":"task.accepted","messagePayload":{}}';

	const { entries, lineErrors } = LogEntryParser.parseJsonl(`${withWrapper}\n${withoutWrapper}`);
	Assert.deepEqual(lineErrors, []);
	Assert.equal(entries[0].messageId, 'message-1');
	Assert.equal(entries[0].inReplyToMessageId, 'message-0');
	Assert.equal(entries[0].protocolVersion, 1);
	// A log recorded before the wrapper existed still parses; it simply carries none of them.
	Assert.equal(entries[1].messageId, undefined);
	Assert.equal(entries[1].inReplyToMessageId, undefined);
});
