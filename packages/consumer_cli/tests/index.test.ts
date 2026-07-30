import Assert from 'node:assert/strict';
import Test from 'node:test';
import { ConsumerClient, type TaskSocket } from '../src/libs/consumer_client.js';
import { TaskInputFactory, taskTypeNames } from '../src/libs/task_input_factory.js';
import { protocolVersion } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for the consumer command line package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('parses finite numeric input', () => {
	Assert.equal(TaskInputFactory.createTaskInput('dev_formula', '12.5').input, 12.5);
	Assert.equal(TaskInputFactory.createTaskInput('dev_formula', '-3').input, -3);
});

Test('rejects missing or non-finite input', () => {
	Assert.throws(() => TaskInputFactory.createTaskInput('dev_formula', undefined), /Input must be a finite number/);
	Assert.throws(() => TaskInputFactory.createTaskInput('dev_formula', 'not-a-number'), /Input must be a finite number/);
	Assert.throws(() => TaskInputFactory.createTaskInput('dev_formula', 'Infinity'), /Input must be a finite number/);
});

Test('validates large-language-model input', () => {
	Assert.equal(TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', ' hello ').input, ' hello ');
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', '  '), /Input must be a non-empty string/);
});

Test('builds the task input for every task type a consumer may submit', () => {
	Assert.deepEqual(taskTypeNames, ['dev_formula', 'llm_qwen3_0_6b_sharded', 'llm_gemma_nano_chrome_full']);
	Assert.equal(TaskInputFactory.isTaskTypeName('llm_gemma_nano_chrome_full'), true);
	Assert.equal(TaskInputFactory.isTaskTypeName('task_type_llm_gemma_nano_chrome_full'), false);
	Assert.deepEqual(TaskInputFactory.createTaskInput('dev_formula', '5'), { taskType: 'task_type_dev_formula', input: 5 });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', 'hello'), { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', 'hello'), { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' });
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', '  '), /Input must be a non-empty string/);
});

Test('registers and submits through the shared client', () => {
	const sent: string[] = [];
	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: (data) => sent.push(data),
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	/** Reads one frame this client sent, and checks the wrapper it travelled in. */
	const sentFrame = (index: number): { v: number; id: string; ts: string; body: Record<string, unknown> } => {
		const frame = JSON.parse(sent[index]) as { v: number; id: string; ts: string; body: Record<string, unknown> };
		Assert.equal(frame.v, protocolVersion);
		Assert.ok(frame.id.length > 0);
		Assert.ok(Number.isFinite(Date.parse(frame.ts)));
		return frame;
	};
	/** Wraps a gateway message the way the gateway does, so the client can read it. */
	const gatewayFrame = (body: unknown, inReplyTo?: string): string =>
		JSON.stringify({ v: protocolVersion, id: `message-${Math.random()}`, ts: new Date().toISOString(), ...(inReplyTo === undefined ? {} : { inReplyTo }), body });

	const client = new ConsumerClient(socket, {}, 'formula-consumer');
	socket.onopen?.();
	const authenticateFrame = sentFrame(0);
	Assert.deepEqual(authenticateFrame.body, { type: 'authenticate', token: 'development-token' });
	socket.onmessage?.({ data: gatewayFrame({ type: 'authenticated', principal: 'principal-development', expiresAt: '2026-01-01T01:00:00.000Z' }, authenticateFrame.id) });
	const registerFrame = sentFrame(1);
	Assert.deepEqual(registerFrame.body, { type: 'register', role: 'consumer', name: 'formula-consumer' });
	socket.onmessage?.({ data: gatewayFrame({ type: 'registered', deviceId: 'device-1' }, registerFrame.id) });
	client.submit({ taskType: 'task_type_dev_formula', input: 5 }, 'request-formula-1');
	const submitFrame = sentFrame(2);
	Assert.deepEqual(submitFrame.body, { type: 'task.submit', requestId: 'request-formula-1', input: { taskType: 'task_type_dev_formula', input: 5 } });
	// Each frame carries its own identifier, so two requests of the same kind can be told apart.
	Assert.notEqual(authenticateFrame.id, registerFrame.id);
	Assert.notEqual(registerFrame.id, submitFrame.id);
});
