import Assert from 'node:assert/strict';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import Test from 'node:test';
import Express from 'express';
import { protocolVersion } from '@webai/protocol';
import type { TaskSocket } from '@webai/consumer-cli';
import { ClusterTaskRunner, type ClusterTaskRunnerOptions } from '../src/libs/cluster_task_runner.js';
import { CurlStyleTransactionLogger } from '../src/libs/curl_style_transaction_logger.js';
import { ModelCatalog } from '../src/libs/model_catalog.js';
import { OpenaiError } from '../src/libs/openai_error.js';
import { OpenaiRoutes } from '../src/libs/openai_routes.js';
import { ChatCompletionRequestSchema, type ChatCompletionResponse } from '../src/libs/openai_types.js';
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
 * Waits until a condition becomes true, checking again after each macrotask.
 *
 * A request sent over a real HTTP connection, unlike the stand-in `TaskSocket` used
 * elsewhere in this file, reaches this process through the network stack rather than
 * synchronously, so a single `settlePromises` does not reliably wait long enough for it to
 * have been read and turned into a `task.submit` frame.
 *
 * @param condition Checked repeatedly until it returns `true`.
 * @throws Error when the condition has not become true after 1 second.
 */
const waitUntil = async (condition: () => boolean): Promise<void> => {
	const deadline = Date.now() + 1_000;
	while (condition() === false) {
		if (Date.now() > deadline) throw new Error('Condition did not become true in time');
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
};

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

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Streaming And Tool Support, Through The Full Request Flow
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The line `CurlStyleTransactionLogger` prints between one transaction and the next. */
const transactionSeparator = '='.repeat(50);

/**
 * Reads one field this logger prints outside the `>`/`<` blocks, such as `Outcome: completed`.
 *
 * @param block One transaction's text, as read back from the log file.
 * @param name The field's name, as printed before its colon.
 * @returns The field's value, or `undefined` when the block does not print it.
 */
const fieldOf = (block: string, name: string): string | undefined => new RegExp(`^${name}: (.*)$`, 'm').exec(block)?.[1];

/**
 * Starts the actual Express routes on an ephemeral port, in front of a stand-in gateway
 * connection, so a test can send it a real HTTP request the way an OpenAI client would.
 *
 * @param overrides Cluster task runner options to use instead of the defaults.
 * @param apiKey The key the routes require, when a test needs to exercise the key check.
 * @returns The stand-in cluster to drive the gateway side, `url` to send requests to, and
 * `transactions` to read the text blocks written to this run's transaction log once the
 * response each one describes has closed.
 */
const listeningServer = async (overrides: Partial<ClusterTaskRunnerOptions> = {}, apiKey?: string): Promise<{ cluster: Awaited<ReturnType<typeof registeredStandInCluster>>; url: string; close: () => void; transactions: () => string[] }> => {
	const cluster = await registeredStandInCluster(overrides);
	const logDirectoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'http-transaction-'));
	const logFilePath = Path.join(logDirectoryPath, 'transactions.log_http.txt');
	const transactionLogger = new CurlStyleTransactionLogger(logFilePath);
	const routes = new OpenaiRoutes(cluster.runner, apiKey, Math.floor(Date.now() / 1000), transactionLogger);
	const app = Express();
	app.use(routes.router());
	const httpServer = app.listen(0);
	await new Promise<void>((resolve) => httpServer.once('listening', resolve));
	const address = httpServer.address();
	if (address === null || typeof address === 'string') throw new Error('Expected the stand-in server to listen on a TCP port');
	const transactions = (): string[] => (Fs.existsSync(logFilePath) ? Fs.readFileSync(logFilePath, 'utf8').split(transactionSeparator).map((block) => block.trim()).filter((block) => block.length > 0) : []);
	return {
		cluster,
		url: `http://127.0.0.1:${address.port}`,
		close: () => {
			httpServer.close();
			Fs.rmSync(logDirectoryPath, { recursive: true, force: true });
		},
		transactions,
	};
};

Test('refuses a streamed request over the full request-response flow, rather than running a task for it', async () => {
	const server = await listeningServer();
	try {
		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }], stream: true }),
		});
		Assert.equal(response.status, 400);
		const body = await response.json() as { error: { type: string; param: string | null; code: string | null } };
		Assert.equal(body.error.code, 'streaming_not_supported');
		Assert.equal(body.error.param, 'stream');
		// Refused before a task is ever submitted, so the gateway sees no `task.submit` for it.
		Assert.equal(server.cluster.runner.tasksInFlight, 0);
	} finally {
		server.close();
	}
});

Test('answers a request carrying tool definitions normally, with those settings ignored', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'dev_formula',
				messages: [{ role: 'user', content: '5' }],
				tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
				tool_choice: 'auto',
			}),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const requestId = server.cluster.lastSentBody()['requestId'];
		Assert.equal(typeof requestId, 'string');
		server.cluster.receive({ type: 'task.accepted', requestId, task: { taskId: 'task-tools-1', requestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-tools-1', revision: 2, state: 'completed', completedStageCount: 2, currentStageAttempts: 0, result: 17 } });

		const response = await responsePromise;
		Assert.equal(response.status, 200);
		const body = await response.json() as ChatCompletionResponse;
		// The request's tool definitions and tool choice carried no weight in this answer: the
		// task ran and completed exactly as it would have without them.
		Assert.equal(body.choices[0]?.message.content, '17');
		Assert.equal(body.choices[0]?.finish_reason, 'stop');
	} finally {
		server.close();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Auditing HTTP Transactions
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('never throws when the log directory cannot be created or the log cannot be written to, so a caller is always answered', () => {
	const directoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'http-transaction-'));
	// A file where a directory is expected, so both creating the log's parent directory and
	// appending to it fail every time.
	const blockingFilePath = Path.join(directoryPath, 'blocking-file');
	Fs.writeFileSync(blockingFilePath, 'not a directory');
	const logger = new CurlStyleTransactionLogger(Path.join(blockingFilePath, 'nested', 'transactions.log_http.txt'));
	Fs.rmSync(directoryPath, { recursive: true, force: true });

	logger.log({
		id: 'request-1', receivedAt: new Date(), method: 'POST', path: '/v1/chat/completions', httpVersion: 'HTTP/1.1',
		requestHeaders: {}, requestBody: { model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }, model: 'dev_formula', authOutcome: 'not_required',
		gatewayRequestId: undefined, gatewayTaskId: undefined, outcome: 'completed', status: 200, responseType: 'chat.completion',
		responseBody: { choices: [{ message: { content: 'hello' } }] }, elapsedMs: 5, callerDisconnected: false,
	});
});

Test('a no-op logger, built from no log file path, writes nothing and never throws', () => {
	const logger = new CurlStyleTransactionLogger(undefined);
	logger.log({
		id: 'request-1', receivedAt: new Date(), method: 'POST', path: '/v1/chat/completions', httpVersion: 'HTTP/1.1',
		requestHeaders: {}, requestBody: { model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }, model: 'dev_formula', authOutcome: 'not_required',
		gatewayRequestId: undefined, gatewayTaskId: undefined, outcome: 'completed', status: 200, responseType: 'chat.completion',
		responseBody: { choices: [{ message: { content: 'hello' } }] }, elapsedMs: 5, callerDisconnected: false,
	});
});

Test('writes one curl-style block per transaction, with both bodies and every header exactly as they went over the connection', () => {
	const directoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'http-transaction-'));
	const logFilePath = Path.join(directoryPath, 'transactions.log_http.txt');
	const logger = new CurlStyleTransactionLogger(logFilePath);

	logger.log({
		id: 'request-1',
		receivedAt: new Date('2026-07-30T13:40:00.000Z'),
		method: 'POST',
		path: '/v1/chat/completions',
		httpVersion: 'HTTP/1.1',
		requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer the-key', cookie: 'session=abc' },
		requestBody: { model: 'dev_formula', messages: [{ role: 'user', content: 'What is the capital of France?' }] },
		model: 'dev_formula',
		authOutcome: 'ok',
		gatewayRequestId: 'gateway-request-1',
		gatewayTaskId: 'task-1',
		outcome: 'completed',
		status: 200,
		responseType: 'chat.completion',
		responseBody: { choices: [{ message: { role: 'assistant', content: 'Paris is the capital of France.' } }] },
		elapsedMs: 18,
		callerDisconnected: false,
	});

	const blocks = Fs.readFileSync(logFilePath, 'utf8').split(transactionSeparator).map((block) => block.trim()).filter((block) => block.length > 0);
	Fs.rmSync(directoryPath, { recursive: true, force: true });
	// One transaction is one block: the whole exchange, not a block for its start and another
	// for its end.
	Assert.equal(blocks.length, 1);
	const [block] = blocks;

	Assert.match(block, /^> POST \/v1\/chat\/completions HTTP\/1\.1$/m);
	// Nothing is redacted: every header is written as it was received, the key included.
	Assert.match(block, /^> authorization: Bearer the-key$/m);
	Assert.match(block, /^> cookie: session=abc$/m);
	Assert.match(block, /^> content-type: application\/json$/m);
	// The request body is written as sent, so the log says what the cluster was actually asked.
	Assert.match(block, /^>\s+"content": "What is the capital of France\?"$/m);
	Assert.match(block, /^< HTTP\/1\.1 200 OK$/m);
	// The answer is written in full too, so the log says what the caller actually received.
	Assert.match(block, /^<\s+"content": "Paris is the capital of France\."$/m);
	Assert.equal(fieldOf(block, 'Transaction'), 'request-1');
	Assert.equal(fieldOf(block, 'Duration'), '18 ms');
	Assert.equal(fieldOf(block, 'Model'), 'dev_formula');
	Assert.equal(fieldOf(block, 'Auth'), 'ok');
	Assert.equal(fieldOf(block, 'Gateway request'), 'gateway-request-1');
	Assert.equal(fieldOf(block, 'Gateway task'), 'task-1');
	Assert.equal(fieldOf(block, 'Outcome'), 'completed');
});

Test('cuts a body short once it runs longer than this logger prints, and says how much was left out', () => {
	const directoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'http-transaction-'));
	const logFilePath = Path.join(directoryPath, 'transactions.log_http.txt');
	const logger = new CurlStyleTransactionLogger(logFilePath);
	const longAnswer = 'a'.repeat(10_000);

	logger.log({
		id: 'request-1', receivedAt: new Date(), method: 'POST', path: '/v1/chat/completions', httpVersion: 'HTTP/1.1',
		requestHeaders: {}, requestBody: { model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }, model: 'dev_formula', authOutcome: 'not_required',
		gatewayRequestId: undefined, gatewayTaskId: undefined, outcome: 'completed', status: 200, responseType: 'chat.completion',
		responseBody: { choices: [{ message: { content: longAnswer } }] }, elapsedMs: 5, callerDisconnected: false,
	});

	const block = Fs.readFileSync(logFilePath, 'utf8');
	Fs.rmSync(directoryPath, { recursive: true, force: true });

	Assert.match(block, /^< Body truncated \(\d+ characters omitted of \d+\)$/m);
	// The short request body next to it is untouched, so only what is actually long is cut.
	Assert.match(block, /^>\s+"content": "5"$/m);
});

Test('audits a successful chat completion as one transaction, with the gateway identifiers it was submitted under', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const requestId = server.cluster.lastSentBody()['requestId'] as string;
		server.cluster.receive({ type: 'task.accepted', requestId, task: { taskId: 'task-audit-1', requestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-audit-1', revision: 2, state: 'completed', completedStageCount: 2, currentStageAttempts: 0, result: 17 } });
		Assert.equal((await responsePromise).status, 200);

		await waitUntil(() => server.transactions().length >= 1);
		const [block] = server.transactions();
		Assert.match(block, /^> POST \/v1\/chat\/completions HTTP\/1\.1$/m);
		// What was asked and what was answered are both in the block, read back off the real
		// connection this test sent the request over.
		Assert.match(block, /^>\s+"content": "5"$/m);
		Assert.match(block, /^< HTTP\/1\.1 200 OK$/m);
		Assert.match(block, /^<\s+"content": "17"$/m);
		Assert.equal(fieldOf(block, 'Model'), 'dev_formula');
		Assert.equal(fieldOf(block, 'Auth'), 'not_required');
		Assert.equal(fieldOf(block, 'Gateway request'), requestId);
		Assert.equal(fieldOf(block, 'Gateway task'), 'task-audit-1');
		Assert.equal(fieldOf(block, 'Outcome'), 'completed');
	} finally {
		server.close();
	}
});

Test('audits a validation failure with the exact status and error code the caller received, and no gateway identifiers', async () => {
	const server = await listeningServer();
	try {
		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }], stream: true }),
		});
		Assert.equal(response.status, 400);

		await waitUntil(() => server.transactions().length >= 1);
		const [block] = server.transactions();
		Assert.equal(fieldOf(block, 'Outcome'), 'failed');
		Assert.match(block, /^< HTTP\/1\.1 400 Bad Request$/m);
		Assert.equal(fieldOf(block, 'Gateway request'), undefined);
		Assert.match(block, /^<\s+"code": "streaming_not_supported"$/m);
	} finally {
		server.close();
	}
});

Test('audits a key that did not match, recording the key that was actually presented', async () => {
	const server = await listeningServer({}, 'the-right-key');
	try {
		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer the-wrong-key' },
			body: JSON.stringify({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }),
		});
		Assert.equal(response.status, 401);

		await waitUntil(() => server.transactions().length >= 1);
		const [block] = server.transactions();
		Assert.equal(fieldOf(block, 'Auth'), 'failed');
		Assert.match(block, /^< HTTP\/1\.1 401 Unauthorized$/m);
		// The key the caller presented is written as received, so a refused call can be told
		// apart from a call that presented no key at all.
		Assert.match(block, /^> authorization: Bearer the-wrong-key$/m);
	} finally {
		server.close();
	}
});

Test('audits a caller that disconnects before an answer arrives as cancelled, not failed', async () => {
	const server = await listeningServer();
	try {
		const abortController = new AbortController();
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }),
			signal: abortController.signal,
		}).catch(() => undefined);
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		abortController.abort();
		await responsePromise;

		await waitUntil(() => server.transactions().length >= 1);
		const [block] = server.transactions();
		Assert.equal(fieldOf(block, 'Outcome'), 'cancelled');
		Assert.match(block, /^< \(no response: the caller disconnected before one was sent\)$/m);
	} finally {
		server.close();
	}
});
