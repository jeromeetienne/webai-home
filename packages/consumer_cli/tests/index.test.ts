import Assert from 'node:assert/strict';
import Test from 'node:test';
import { ConsumerClient, type TaskSocket } from '../src/gateway_connection/consumer_client.js';
import { TaskInputFactory, taskTypeNames } from '../src/libs/task_input_factory.js';
import { DeviceAvailability } from '../src/cluster_capacity/device_availability.js';
import { CapacityCalculator } from '../src/cluster_capacity/capacity_calculator.js';
import { ObserverClient } from '../src/gateway_connection/observer_client.js';
import { protocolVersion, type Device, type PipelineSpecification, type ProtocolError } from '@webai/protocol';
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
	Assert.deepEqual(taskTypeNames, ['dev_formula', 'llm_qwen3_0_6b_sharded', 'llm_gemma_nano_chrome_full', 'llm_qwen3_5_0_8b_full', 'llm_llama3_2_3b_full']);
	Assert.equal(TaskInputFactory.isTaskTypeName('llm_gemma_nano_chrome_full'), true);
	Assert.equal(TaskInputFactory.isTaskTypeName('task_type_llm_gemma_nano_chrome_full'), false);
	Assert.deepEqual(TaskInputFactory.createTaskInput('dev_formula', '5'), { taskType: 'task_type_dev_formula', input: 5 });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', 'hello'), { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello' });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', 'hello'), { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' });
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', '  '), /Input must be a non-empty string/);
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_qwen3_5_0_8b_full', 'hello'), { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'hello' });
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_qwen3_5_0_8b_full', '  '), /Input must be a non-empty string/);
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_llama3_2_3b_full', 'hello'), { taskType: 'task_type_llm_llama3_2_3b_full', input: 'hello' });
	Assert.throws(() => TaskInputFactory.createTaskInput('llm_llama3_2_3b_full', '  '), /Input must be a non-empty string/);
});

Test('carries the generation settings a consumer asked for, and refuses one the task type cannot honour', () => {
	// A submission that asks for nothing carries no settings field at all, so it stays exactly
	// the submission this client sent before generation settings existed.
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', 'hello'), { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello' });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_gemma_nano_chrome_full', 'hello', { isStreaming: true }), { taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'hello', generationSettings: { isStreaming: true } });
	Assert.deepEqual(TaskInputFactory.createTaskInput('llm_qwen3_0_6b_sharded', 'hello', { isStreaming: true }), { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: 'hello', generationSettings: { isStreaming: true } });
	Assert.throws(() => TaskInputFactory.createTaskInput('dev_formula', '5', { isStreaming: true }), /cannot produce its answer in pieces/);
	Assert.deepEqual(TaskInputFactory.createTaskInput('dev_formula', '5', { isStreaming: false }), { taskType: 'task_type_dev_formula', input: 5, generationSettings: { isStreaming: false } });
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
	const gatewayFrame = (body: unknown, inReplyToMessageId?: string): string =>
		JSON.stringify({ v: protocolVersion, id: `message-${Math.random()}`, ts: new Date().toISOString(), ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }), body });

	const client = new ConsumerClient(socket, {}, 'formula-consumer');
	socket.onopen?.();
	const authenticateFrame = sentFrame(0);
	Assert.deepEqual(authenticateFrame.body, { type: 'deviceAuthenticate', token: 'development-token' });
	socket.onmessage?.({ data: gatewayFrame({ type: 'deviceAuthenticated', authIdentity: 'authIdentity-development', expiresAt: '2026-01-01T01:00:00.000Z' }, authenticateFrame.id) });
	const registerFrame = sentFrame(1);
	Assert.deepEqual(registerFrame.body, { type: 'deviceRegister', role: 'consumer', name: 'formula-consumer' });
	socket.onmessage?.({ data: gatewayFrame({ type: 'deviceRegistered', deviceId: 'device-1' }, registerFrame.id) });
	client.submit({ taskType: 'task_type_dev_formula', input: 5 }, 'request-formula-1');
	const submitFrame = sentFrame(2);
	Assert.deepEqual(submitFrame.body, { type: 'task.submit', taskRequestId: 'request-formula-1', input: { taskType: 'task_type_dev_formula', input: 5 } });
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
	const gatewayError: ProtocolError = { type: 'error', code: 'RATE_LIMITED', message: 'The authIdentity has reached its active-task limit', taskRequestId: 'request-formula-1', retryable: true };
	socket.onmessage?.({ data: JSON.stringify({ v: protocolVersion, id: 'message-1', ts: new Date().toISOString(), body: gatewayError }) });
	Assert.deepEqual(errors, [gatewayError]);

	// A failure the client noticed itself is reported in the same shape, so a caller reading
	// the callback handles one shape rather than two.
	socket.onmessage?.({ data: 'not json at all' });
	Assert.deepEqual(errors[1], { type: 'error', code: 'INVALID_MESSAGE', message: 'The central gateway sent invalid data' });
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DeviceAvailability
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('reads whether a worker device may take on another assignment', () => {
	const baseDevice: Device = {
		deviceId: 'worker-1', name: 'Worker 1', deviceRole: 'worker', stageNames: ['stage_a'],
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
	};
	Assert.equal(DeviceAvailability.isAvailable(baseDevice), true);
	Assert.equal(DeviceAvailability.availableCapacity(baseDevice), 1);

	Assert.equal(DeviceAvailability.isAvailable({ ...baseDevice, workerState: 'draining' }), false);
	Assert.equal(DeviceAvailability.isAvailable({ ...baseDevice, ready: false }), false);
	Assert.equal(DeviceAvailability.isAvailable({ ...baseDevice, maxConcurrentAssignments: 2, activeAssignments: 2 }), false);
	Assert.equal(DeviceAvailability.isAvailable({ ...baseDevice, maxConcurrentAssignments: 2, activeAssignments: 1 }), true);

	Assert.equal(DeviceAvailability.availableCapacity({ ...baseDevice, maxConcurrentAssignments: 3, activeAssignments: 1 }), 2);
	Assert.equal(DeviceAvailability.availableCapacity({ ...baseDevice, workerState: 'draining', maxConcurrentAssignments: 3 }), 0);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CapacityCalculator
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('estimates worker-pinned capacity as the total free capacity of workers advertising every shard', () => {
	const shardStages = ['stage_llm_qwen3_0_6b_shard1of3', 'stage_llm_qwen3_0_6b_shard2of3', 'stage_llm_qwen3_0_6b_shard3of3'];
	const pipeline: PipelineSpecification = {
		pipelineId: 'llm_qwen3_0_6b_sharded', version: 1, taskType: 'task_type_llm_qwen3_0_6b_sharded', repeatsUntilDone: true,
		stages: shardStages.map((name) => ({ name, computation: 'llm_qwen3_0_6b_shard', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', prefersSameWorkerOnRetry: true })),
	};
	/** A worker device with the given stages, one free slot, connected and last seen at a fixed time. */
	const worker = (deviceId: string, stageNames: string[]): Device => ({
		deviceId, name: deviceId, deviceRole: 'worker', stageNames,
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
		maxConcurrentAssignments: 1, activeAssignments: 0,
	});
	// 5 workers advertise all 3 shards, with one free slot each; 3 more advertise only the first
	// shard, so they cannot host a run of this pipeline at all — matching the example from
	// https://github.com/webai-at-home/webai-at-home/issues/90.
	const devices: Device[] = [
		worker('worker-1', shardStages), worker('worker-2', shardStages), worker('worker-3', shardStages),
		worker('worker-4', shardStages), worker('worker-5', shardStages),
		worker('worker-6', [shardStages[0] as string]), worker('worker-7', [shardStages[0] as string]), worker('worker-8', [shardStages[0] as string]),
	];
	const result = CapacityCalculator.calculate(pipeline, devices);
	Assert.equal(result.capacity, 5);
	Assert.equal(result.reason, 'worker coverage (5 of 8 workers advertise all 3 stages)');
});

Test('estimates independent-stage capacity as the bottleneck stage\'s free capacity', () => {
	const pipeline: PipelineSpecification = {
		pipelineId: 'dev_formula', version: 1, taskType: 'task_type_dev_formula',
		stages: [
			{ name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
			{ name: 'stage_dev_formula_add', computation: 'dev_formula_add', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
		],
	};
	/** A worker device advertising one stage, with one free slot. */
	const worker = (deviceId: string, stageName: string): Device => ({
		deviceId, name: deviceId, deviceRole: 'worker', stageNames: [stageName],
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
		maxConcurrentAssignments: 1, activeAssignments: 0,
	});
	// 7 workers can run the multiply stage, only 3 can run the add stage — each stage can run on
	// a different worker, so the add stage's 3 free slots are what limits the whole pipeline.
	const devices: Device[] = [
		...Array.from({ length: 7 }, (_, index) => worker(`multiply-${index}`, 'stage_dev_formula_multiply')),
		...Array.from({ length: 3 }, (_, index) => worker(`add-${index}`, 'stage_dev_formula_add')),
	];
	const result = CapacityCalculator.calculate(pipeline, devices);
	Assert.equal(result.capacity, 3);
	Assert.equal(result.reason, 'stage_dev_formula_add (3 available slots vs 7 on stage_dev_formula_multiply)');
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ObserverClient
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('tracks the live device list an observer connection reports', () => {
	const sent: string[] = [];
	const socket: TaskSocket = {
		readyState: 1, OPEN: 1, send: (data) => sent.push(data), close: () => undefined,
		onopen: null, onmessage: null, onerror: null, onclose: null,
	};
	/** Wraps a gateway message the way the gateway does, so the client can read it. */
	const gatewayFrame = (body: unknown, inReplyToMessageId?: string): string =>
		JSON.stringify({ v: protocolVersion, id: `message-${Math.random()}`, ts: new Date().toISOString(), ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }), body });

	const snapshots: Device[][] = [];
	new ObserverClient(socket, { onDevices: (devices) => snapshots.push(devices) }, 'observer-token');
	socket.onopen?.();
	const authenticateFrame = JSON.parse(sent[0] as string) as { id: string; body: Record<string, unknown> };
	Assert.deepEqual(authenticateFrame.body, { type: 'deviceAuthenticate', token: 'observer-token' });
	socket.onmessage?.({ data: gatewayFrame({ type: 'deviceAuthenticated', authIdentity: 'authIdentity-development', expiresAt: '2026-01-01T01:00:00.000Z' }, authenticateFrame.id) });
	Assert.deepEqual((JSON.parse(sent[1] as string) as { body: unknown }).body, { type: 'observe' });

	const worker: Device = {
		deviceId: 'worker-1', name: 'Worker 1', deviceRole: 'worker', stageNames: ['stage_a'],
		connectedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
		maxConcurrentAssignments: 2, activeAssignments: 0,
	};
	socket.onmessage?.({ data: gatewayFrame({ type: 'devices', devices: [worker], deviceListRevision: 1 }) });
	Assert.deepEqual(snapshots[0], [worker]);

	const joinedWorker: Device = { ...worker, deviceId: 'worker-2', name: 'Worker 2' };
	socket.onmessage?.({ data: gatewayFrame({ type: 'device.joined', device: joinedWorker, deviceListRevision: 2 }) });
	Assert.deepEqual(snapshots[1]?.map((device) => device.deviceId), ['worker-1', 'worker-2']);

	// Only the changed activity fields are merged in, so a field an activity message left out
	// keeps the value the stored device already had — here, its stage list and concurrency limit.
	socket.onmessage?.({ data: gatewayFrame({ type: 'device.activity', devices: [{ deviceId: 'worker-1', lastSeenAt: '2026-01-01T00:01:00.000Z', activeAssignments: 1 }], deviceListRevision: 3 }) });
	const updatedWorker = snapshots[2]?.find((device) => device.deviceId === 'worker-1');
	Assert.equal(updatedWorker?.activeAssignments, 1);
	Assert.equal(updatedWorker?.maxConcurrentAssignments, 2);
	Assert.deepEqual(updatedWorker?.stageNames, ['stage_a']);

	socket.onmessage?.({ data: gatewayFrame({ type: 'device.left', deviceId: 'worker-2', deviceListRevision: 4 }) });
	Assert.deepEqual(snapshots[3]?.map((device) => device.deviceId), ['worker-1']);
});

Test('requests and reports the registered pipelines when asked to', () => {
	const sent: string[] = [];
	const socket: TaskSocket = {
		readyState: 1, OPEN: 1, send: (data) => sent.push(data), close: () => undefined,
		onopen: null, onmessage: null, onerror: null, onclose: null,
	};
	const gatewayFrame = (body: unknown, inReplyToMessageId?: string): string =>
		JSON.stringify({ v: protocolVersion, id: `message-${Math.random()}`, ts: new Date().toISOString(), ...(inReplyToMessageId === undefined ? {} : { inReplyToMessageId }), body });

	const pipelinesReceived: PipelineSpecification[][] = [];
	new ObserverClient(socket, { onPipelines: (pipelines) => pipelinesReceived.push(pipelines) }, 'observer-token', true);
	socket.onopen?.();
	const authenticateFrame = JSON.parse(sent[0] as string) as { id: string };
	socket.onmessage?.({ data: gatewayFrame({ type: 'deviceAuthenticated', authIdentity: 'authIdentity-development', expiresAt: '2026-01-01T01:00:00.000Z' }, authenticateFrame.id) });
	Assert.deepEqual((JSON.parse(sent[1] as string) as { body: unknown }).body, { type: 'observe' });
	Assert.deepEqual((JSON.parse(sent[2] as string) as { body: unknown }).body, { type: 'pipelines.get' });

	const pipeline: PipelineSpecification = {
		pipelineId: 'dev_formula', version: 1, taskType: 'task_type_dev_formula',
		stages: [{ name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' }],
	};
	socket.onmessage?.({ data: gatewayFrame({ type: 'pipelines', pipelines: [pipeline] }) });
	Assert.deepEqual(pipelinesReceived, [[pipeline]]);
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
