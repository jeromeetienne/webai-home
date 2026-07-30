// node imports
import Crypto from 'node:crypto';

// npm imports
import Express from 'express';
import { TaskInputFactory } from '@webai/consumer-cli/libs/task_input_factory';
import type { TaskInput } from '@webai/protocol';
import type { z } from 'zod';

// local imports
import type { ClusterTaskRunner } from './cluster_task_runner.js';
import { ModelCatalog } from './model_catalog.js';
import { OpenaiError } from './openai_error.js';
import { PromptFlattener } from './prompt_flattener.js';
import { ChatCompletionRequestSchema, type ChatCompletionResponse, type HealthResponse } from './openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiRoutes — the endpoints this server answers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The largest request body this server reads. */
const bodySizeLimit = '1mb';

/**
 * The endpoints this server answers: the two of the OpenAI completion interface it serves, and
 * one that reports its own state.
 *
 * Every failure leaves here as an `OpenaiError`, which carries both the HTTP status and the
 * body, so that the list of ways a request can fail is read in one file rather than being
 * spread across the handlers.
 */
export class OpenaiRoutes {
	/**
	 * @param runner Runs one cluster task per request.
	 * @param apiKey The key a request must present, when this server was started with one.
	 * @param startedAtSeconds When this server started, as a whole number of seconds since the
	 * start of 1970, which is the creation date it states for every model.
	 */
	constructor(
		private readonly runner: ClusterTaskRunner,
		private readonly apiKey: string | undefined,
		private readonly startedAtSeconds: number,
	) {}

	/**
	 * Builds the routes, in the order they are tried.
	 *
	 * @returns The Express router to mount on the server.
	 */
	router(): Express.Router {
		const router = Express.Router();
		router.use(Express.json({ limit: bodySizeLimit }));

		// The state of this server is readable without a key, so that whatever watches it does
		// not have to hold one.
		router.get('/health', (_request, response) => {
			const health: HealthResponse = {
				ok: this.runner.isGatewayConnected,
				isGatewayConnected: this.runner.isGatewayConnected,
				tasksInFlight: this.runner.tasksInFlight,
			};
			response.status(health.ok ? 200 : 503).json(health);
		});

		router.use('/v1', (request, response, next) => {
			try {
				this.checkApiKey(request);
				next();
			} catch (failure: unknown) {
				OpenaiRoutes.sendFailure(response, failure);
			}
		});

		router.get('/v1/models', (_request, response) => {
			response.status(200).json(ModelCatalog.list(this.startedAtSeconds));
		});

		// An asynchronous handler that fails does not reach the error handling of Express by
		// itself, so this route catches its own failures rather than relying on that.
		router.post('/v1/chat/completions', (request, response) => {
			void this.handleChatCompletion(request, response).catch((failure: unknown) => OpenaiRoutes.sendFailure(response, failure));
		});

		// A body that is not valid JSON is refused by the reader mounted above, which fails
		// before any handler runs, so its failure is turned into an answer here.
		const reportBodyFailure: Express.ErrorRequestHandler = (error, _request, response, _next) => {
			OpenaiRoutes.sendFailure(response, OpenaiError.invalidRequest(`The request body could not be read as JSON: ${error instanceof Error ? error.message : String(error)}.`));
		};
		router.use(reportBodyFailure);

		return router;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Chat Completions
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Answers one chat completion request by running one cluster task.
	 *
	 * @param request The incoming request.
	 * @param response The response to answer with.
	 * @throws OpenaiError when the request cannot be read or the cluster cannot serve it.
	 */
	private async handleChatCompletion(request: Express.Request, response: Express.Response): Promise<void> {
		const parsed = ChatCompletionRequestSchema.safeParse(request.body);
		if (parsed.success === false) throw OpenaiRoutes.schemaFailureOf(parsed.error);
		const body = parsed.data;
		if (body.stream === true) throw OpenaiError.streamingRefused();
		const taskTypeName = ModelCatalog.taskTypeNameOf(body.model);
		if (taskTypeName === undefined) throw OpenaiError.unknownModel(body.model, ModelCatalog.modelIds);

		const prompt = PromptFlattener.flatten(body.messages);
		let taskInput: TaskInput;
		try {
			taskInput = TaskInputFactory.createTaskInput(taskTypeName, prompt);
		} catch (error: unknown) {
			throw OpenaiError.unusableMessages(`The model ${body.model} cannot take the text of this request: ${error instanceof Error ? error.message : String(error)}.`);
		}

		// A caller that hangs up before the answer arrives has its task cancelled, so the
		// cluster stops running stages for an answer nobody will read.
		const abortController = new AbortController();
		request.on('close', () => {
			if (response.writableEnded === false) abortController.abort();
		});

		const answer = await this.runner.run(taskInput, body.model, abortController.signal);
		const completion: ChatCompletionResponse = {
			id: `chatcmpl-${Crypto.randomUUID()}`,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: body.model,
			choices: [{ index: 0, message: { role: 'assistant', content: answer }, logprobs: null, finish_reason: 'stop' }],
		};
		if (response.writableEnded === true) return;
		response.status(200).json(completion);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reading The Request
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Turns the reasons a body failed its checks into one failure naming each of them.
	 *
	 * @param failure The reasons the schema gave.
	 * @returns The failure to answer with.
	 */
	private static schemaFailureOf(failure: z.ZodError): OpenaiError {
		const reasons = failure.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
		const firstPathPart = failure.issues[0]?.path[0];
		const param = typeof firstPathPart === 'string' ? firstPathPart : null;
		return OpenaiError.invalidRequest(`The request body is not one this server can read. ${reasons}. A message's content must be a single piece of text; a list of content parts is not accepted.`, param);
	}

	/**
	 * Checks the key a request presents, when this server was started with one to require.
	 *
	 * @param request The incoming request.
	 * @throws OpenaiError when the key is absent or does not match.
	 */
	private checkApiKey(request: Express.Request): void {
		const apiKey = this.apiKey;
		if (apiKey === undefined) return;
		const presentedMatch = /^Bearer (.*)$/i.exec(request.header('authorization') ?? '');
		if (presentedMatch === null) throw OpenaiError.authenticationFailed();
		const presented = Buffer.from(presentedMatch[1], 'utf8');
		const expected = Buffer.from(apiKey, 'utf8');
		// The two are compared in a way that takes the same time whether they match early or
		// late, which needs them to be the same length before they are compared at all.
		if (presented.length !== expected.length) throw OpenaiError.authenticationFailed();
		if (Crypto.timingSafeEqual(presented, expected) === false) throw OpenaiError.authenticationFailed();
	}

	/**
	 * Answers a request with a failure.
	 *
	 * @param response The response to answer with.
	 * @param failure The failure. Anything that is not an `OpenaiError` is a fault in this
	 * server rather than in the request, so it is reported as such and written to this server's
	 * own output.
	 */
	private static sendFailure(response: Express.Response, failure: unknown): void {
		if (response.writableEnded === true) return;
		if (failure instanceof OpenaiError) {
			response.status(failure.status).json(failure.body);
			return;
		}
		console.error(failure);
		const unexpected = OpenaiError.unexpected();
		response.status(unexpected.status).json(unexpected.body);
	}
}
