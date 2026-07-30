import Assert from 'node:assert/strict';
import Test from 'node:test';
import { protocolVersion } from '@webai/protocol';
import type { TaskSocket } from '@webai/consumer-cli/libs/consumer_client';
import { ClusterTaskRunner, type ClusterTaskRunnerOptions } from '../src/libs/cluster_task_runner.js';
import { ModelCatalog } from '../src/libs/model_catalog.js';
import { OpenaiError } from '../src/libs/openai_error.js';
import { ChatCompletionRequestSchema } from '../src/libs/openai_types.js';
import { PromptFlattener } from '../src/libs/prompt_flattener.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for the OpenAI-compatible server package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Reading A Request
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('sends a single message unchanged, so a model that takes a number can be used', () => {
	Assert.equal(PromptFlattener.flatten([{ role: 'user', content: '5' }]), '5');
	Assert.equal(PromptFlattener.flatten([{ role: 'user', content: 'What is the capital of France?' }]), 'What is the capital of France?');
});

Test('labels several messages with their roles and invites the answer', () => {
	const prompt = PromptFlattener.flatten([
		{ role: 'system', content: 'Answer in one short sentence.' },
		{ role: 'user', content: 'What is the capital of France?' },
	]);
	Assert.equal(prompt, 'system: Answer in one short sentence.\nuser: What is the capital of France?\nassistant:');
});

Test('reads the fields it uses and ignores every other generation setting', () => {
	const parsed = ChatCompletionRequestSchema.safeParse({
		model: 'llm_gemma_nano_chrome_full',
		messages: [{ role: 'user', content: 'hello' }],
		temperature: 0.7,
		top_p: 0.9,
		max_tokens: 64,
		n: 3,
		tools: [{ type: 'function' }],
	});
	Assert.equal(parsed.success, true);
	Assert.deepEqual(parsed.success === true ? parsed.data : undefined, { model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'hello' }] });
});

Test('refuses a body it cannot read', () => {
	Assert.equal(ChatCompletionRequestSchema.safeParse({ messages: [{ role: 'user', content: 'hello' }] }).success, false);
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages: [] }).success, false);
	// A content part list, which a request carrying an image sends, is refused rather than
	// having its parts joined together.
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }).success, false);
	// The tool role is refused, because this server ignores the tool settings of a request.
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages: [{ role: 'tool', content: 'hello' }] }).success, false);
});

Test('reads whether the request asks for the answer to be streamed', () => {
	const parsed = ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }], stream: true });
	Assert.equal(parsed.success === true ? parsed.data.stream : undefined, true);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Models On Offer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('offers one model for each task type the cluster runs', () => {
	Assert.deepEqual(ModelCatalog.modelIds, ['dev_formula', 'llm_qwen3_0_6b_sharded', 'llm_gemma_nano_chrome_full']);
	Assert.equal(ModelCatalog.taskTypeNameOf('dev_formula'), 'dev_formula');
	Assert.equal(ModelCatalog.taskTypeNameOf('llm_qwen3_0_6b_sharded'), 'llm_qwen3_0_6b_sharded');
	Assert.equal(ModelCatalog.taskTypeNameOf('llm_gemma_nano_chrome_full'), 'llm_gemma_nano_chrome_full');
	// The task type name itself is not a model identifier, and neither is a name nobody offers.
	Assert.equal(ModelCatalog.taskTypeNameOf('task_type_dev_formula'), undefined);
	Assert.equal(ModelCatalog.taskTypeNameOf('gpt-4o'), undefined);
});

Test('lists the models in the shape an OpenAI client reads', () => {
	const list = ModelCatalog.list(1_700_000_000);
	Assert.equal(list.object, 'list');
	Assert.equal(list.data.length, 3);
	Assert.deepEqual(list.data[0], { id: 'dev_formula', object: 'model', created: 1_700_000_000, owned_by: 'webai-at-home' });
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Failures
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('answers each kind of failure with the status an OpenAI client expects', () => {
	Assert.equal(OpenaiError.invalidRequest('bad body').status, 400);
	Assert.equal(OpenaiError.streamingRefused().status, 400);
	Assert.equal(OpenaiError.unusableMessages('not a number').status, 400);
	Assert.equal(OpenaiError.authenticationFailed().status, 401);
	Assert.equal(OpenaiError.unknownModel('gpt-4o', ModelCatalog.modelIds).status, 404);
	Assert.equal(OpenaiError.tooManyTasksInFlight(20).status, 429);
	Assert.equal(OpenaiError.gatewayRateLimited('too many').status, 429);
	Assert.equal(OpenaiError.taskFailed('a stage failed').status, 502);
	Assert.equal(OpenaiError.answerUnreadable('task_type_dev_formula').status, 502);
	Assert.equal(OpenaiError.unexpected().status, 500);
	Assert.equal(OpenaiError.gatewayUnavailable('not connected').status, 503);
	Assert.equal(OpenaiError.noVolunteerAvailable('dev_formula').status, 503);
	Assert.equal(OpenaiError.requestTimedOut(600_000).status, 504);
});

Test('names the field at fault and the failure kind in the body', () => {
	const streaming = OpenaiError.streamingRefused().body;
	Assert.equal(streaming.error.type, 'invalid_request_error');
	Assert.equal(streaming.error.param, 'stream');
	Assert.equal(streaming.error.code, 'streaming_not_supported');
	const unknownModel = OpenaiError.unknownModel('gpt-4o', ModelCatalog.modelIds).body;
	Assert.equal(unknownModel.error.param, 'model');
	Assert.equal(unknownModel.error.code, 'model_not_found');
	// Every model on offer is named, so the caller can correct the request without asking.
	Assert.match(unknownModel.error.message, /dev_formula, llm_qwen3_0_6b_sharded, llm_gemma_nano_chrome_full/);
	// `param` and `code` are always present, holding null when they say nothing.
	const rateLimited = OpenaiError.tooManyTasksInFlight(20).body;
	Assert.equal(rateLimited.error.type, 'rate_limit_error');
	Assert.equal(rateLimited.error.param, null);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Running A Cluster Task
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One frame sent by the runner, as the gateway would receive it. */
type SentFrame = { v: number; id: string; ts: string; body: Record<string, unknown> };

/** A stand-in connection, and the runner that speaks to the gateway through it. */
type StandInCluster = {
	runner: ClusterTaskRunner;
	socket: TaskSocket;
	/** Every frame the runner sent, most recent last. */
	sentFrames: () => SentFrame[];
	/** The body of the most recent frame the runner sent. */
	lastSentBody: () => Record<string, unknown>;
	/** Hands the runner one message, wrapped the way the gateway wraps it. */
	receive: (body: unknown) => void;
};

/** Lets every already-scheduled promise settle before the test looks at the result. */
const settlePromises = async (): Promise<void> => await new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Builds a runner whose connection is a stand-in the test drives itself, and takes it as far
 * as being registered, which is the state a request needs it in.
 *
 * @param overrides Options to use instead of the defaults.
 * @returns The runner, its stand-in connection, and the means to read and feed messages.
 */
const registeredStandInCluster = async (overrides: Partial<ClusterTaskRunnerOptions> = {}): Promise<StandInCluster> => {
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
	const sentFrames = (): SentFrame[] => sent.map((raw) => JSON.parse(raw) as SentFrame);
	const receive = (body: unknown): void => {
		socket.onmessage?.({ data: JSON.stringify({ v: protocolVersion, id: `message-${sent.length}`, ts: new Date().toISOString(), body }) });
	};
	const runner = new ClusterTaskRunner({
		gatewayUrl: 'ws://stand-in',
		authToken: 'development-token',
		name: 'openai-consumer',
		requestTimeoutMs: 60_000,
		connectionWaitMs: 50,
		maximumTasksInFlight: 20,
		...overrides,
	}, () => socket);
	socket.onopen?.();
	// One hour ahead, which is what the gateway's own --session-ms defaults to. A far-future
	// expiry would ask Node for a timer longer than it can hold.
	const sessionExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
	receive({ type: 'authenticated', principal: 'principal-development', expiresAt: sessionExpiresAt });
	receive({ type: 'registered', deviceId: 'device-openai-1' });
	await settlePromises();
	return { runner, socket, sentFrames, lastSentBody: () => sentFrames()[sent.length - 1]?.body ?? {}, receive };
};

Test('submits one task per request and answers with the text it generated', async () => {
	const cluster = await registeredStandInCluster();
	Assert.equal(cluster.runner.isGatewayConnected, true);

	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const submitted = cluster.lastSentBody();
	Assert.equal(submitted['type'], 'task.submit');
	Assert.deepEqual(submitted['input'], { taskType: 'task_type_dev_formula', input: 5 });
	const requestId = submitted['requestId'];
	Assert.equal(typeof requestId, 'string');
	Assert.equal(cluster.runner.tasksInFlight, 1);

	// The accepted task carries back the identifier the submission was sent under, which is what
	// joins every later revision of that task to this request.
	cluster.receive({ type: 'task.accepted', requestId, task: { taskId: 'task-1', requestId, state: 'queued' } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-1', revision: 3, state: 'running', completedStageCount: 1, currentStageAttempts: 1 } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-1', revision: 4, state: 'completed', completedStageCount: 2, currentStageAttempts: 0, result: 17 } });

	// A development formula task carries a plain number, so its answer is that number written out.
	Assert.equal(await answer, '17');
	Assert.equal(cluster.runner.tasksInFlight, 0);
	cluster.runner.close();
});

Test('answers with the generated text of a language-model task', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?' }, 'llm_gemma_nano_chrome_full');
	await settlePromises();
	const requestId = cluster.lastSentBody()['requestId'];
	cluster.receive({ type: 'task.accepted', requestId, task: { taskId: 'task-2', requestId, state: 'queued' } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-2', revision: 9, state: 'completed', completedStageCount: 4, currentStageAttempts: 0, result: { text: 'Paris is the capital of France.', done: true } } });
	Assert.equal(await answer, 'Paris is the capital of France.');
	cluster.runner.close();
});

Test('reports that no volunteer browser offered the work when the task waited too long', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const requestId = cluster.lastSentBody()['requestId'];
	cluster.receive({ type: 'task.accepted', requestId, task: { taskId: 'task-3', requestId, state: 'queued' } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-3', revision: 2, state: 'failed', completedStageCount: 0, currentStageAttempts: 0, error: 'SUBMISSION_DEADLINE_EXPIRED' } });
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 503);
	Assert.equal(failure.code, 'no_volunteer_available');
	Assert.match(failure.message, /dev_formula/);
	cluster.runner.close();
});

Test('reports a task the cluster ran and failed as a fault of the cluster', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const requestId = cluster.lastSentBody()['requestId'];
	cluster.receive({ type: 'task.accepted', requestId, task: { taskId: 'task-4', requestId, state: 'queued' } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-4', revision: 5, state: 'failed', completedStageCount: 1, currentStageAttempts: 3, error: 'the assignment attempts were used up' } });
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 502);
	Assert.match(failure.message, /the assignment attempts were used up/);
	cluster.runner.close();
});

Test('passes on the gateway refusing a submission it has no room for', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const requestId = cluster.lastSentBody()['requestId'];
	cluster.receive({ type: 'error', code: 'RATE_LIMITED', message: 'The principal has reached its active-task limit', requestId, retryable: true });
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 429);
	cluster.runner.close();
});

Test('gives up on every request still waiting when the connection is lost', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	cluster.socket.onclose?.();
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 503);
	Assert.equal(cluster.runner.isGatewayConnected, false);
	Assert.equal(cluster.runner.tasksInFlight, 0);
	cluster.runner.close();
});

Test('cancels the task when whoever sent the request goes away', async () => {
	const cluster = await registeredStandInCluster();
	const abortController = new AbortController();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula', abortController.signal);
	await settlePromises();
	const requestId = cluster.lastSentBody()['requestId'];
	cluster.receive({ type: 'task.accepted', requestId, task: { taskId: 'task-5', requestId, state: 'queued' } });
	abortController.abort();
	const cancelled = cluster.lastSentBody();
	Assert.equal(cancelled['type'], 'task.cancel');
	Assert.equal(cancelled['taskId'], 'task-5');
	await answer.then(() => undefined, () => undefined);
	Assert.equal(cluster.runner.tasksInFlight, 0);
	cluster.runner.close();
});

Test('refuses a request that arrives while the gateway is not connected, rather than holding it', async () => {
	const socket: TaskSocket = {
		readyState: 0,
		OPEN: 1,
		send: () => undefined,
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	const runner = new ClusterTaskRunner({
		gatewayUrl: 'ws://stand-in',
		authToken: 'development-token',
		name: 'openai-consumer',
		requestTimeoutMs: 60_000,
		connectionWaitMs: 20,
		maximumTasksInFlight: 20,
	}, () => socket);
	const failure = await runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula').then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 503);
	Assert.equal(failure.code, 'gateway_unavailable');
	runner.close();
});

Test('holds no more tasks in flight than it was told to', async () => {
	const cluster = await registeredStandInCluster({ maximumTasksInFlight: 1 });
	const first = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const failure = await cluster.runner.run({ taskType: 'task_type_dev_formula', input: 6 }, 'dev_formula').then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 429);
	Assert.equal(failure.code, 'too_many_tasks_in_flight');
	cluster.runner.close();
	await first.then(() => undefined, () => undefined);
});
