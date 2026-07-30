import Assert from 'node:assert/strict';
import Test from 'node:test';
import { ConsumerClient, type TaskSocket } from '../src/libs/consumer_client.js';
import { TaskInputFactory, taskTypeNames } from '../src/libs/task_input_factory.js';
import { protocolVersion, type ProtocolError } from '@webai/protocol';
import * as ConsumerCli from '@webai/consumer-cli';

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
	client.cancel('task-1', 'the caller went away');
	Assert.deepEqual(sentFrame(3).body, { type: 'task.cancel', taskId: 'task-1', reason: 'the caller went away' });
	// Each frame carries its own identifier, so two requests of the same kind can be told apart.
	Assert.notEqual(authenticateFrame.id, registerFrame.id);
	Assert.notEqual(registerFrame.id, submitFrame.id);
});

Test('reports an error the gateway sent with its code and its request identifier', () => {
	const errors: ProtocolError[] = [];
	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: () => undefined,
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	new ConsumerClient(socket, { onError: (error) => errors.push(error) });
	const gatewayError: ProtocolError = { type: 'error', code: 'RATE_LIMITED', message: 'The principal has reached its active-task limit', requestId: 'request-formula-1', retryable: true };
	socket.onmessage?.({ data: JSON.stringify({ v: protocolVersion, id: 'message-1', ts: new Date().toISOString(), body: gatewayError }) });
	Assert.deepEqual(errors, [gatewayError]);

	// A failure the client noticed itself is reported in the same shape, so a caller reading
	// the callback handles one shape rather than two.
	socket.onmessage?.({ data: 'not json at all' });
	Assert.deepEqual(errors[1], { type: 'error', code: 'INVALID_MESSAGE', message: 'The central gateway sent invalid data' });
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Public Exports
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// This resolves `@webai/consumer-cli` through its package.json `exports` field, into the
// built `dist/index.js`, exactly as a package outside this one would import it, so it is a
// separate loaded module from the `../src/...` imports above rather than the same class —
// hence checking what it does, rather than reference-comparing it to the `src` version.
// Running this test therefore needs `npm run build --workspace @webai/consumer-cli` to have
// run first, the same requirement `@webai/consumer_openai` already has on this package.
Test('exposes the reusable consumer symbols through the package entry point after a build', () => {
	Assert.deepEqual(ConsumerCli.taskTypeNames, taskTypeNames);
	Assert.deepEqual(ConsumerCli.TaskInputFactory.createTaskInput('dev_formula', '5'), { taskType: 'task_type_dev_formula', input: 5 });

	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: () => undefined,
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	Assert.ok(new ConsumerCli.ConsumerClient(socket, {}, 'built-consumer') instanceof ConsumerCli.ConsumerClient);
	Assert.equal('Cli' in ConsumerCli, false);
});
