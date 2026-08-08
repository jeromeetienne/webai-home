// npm imports
import OpenAI, { APIError } from 'openai';

// local imports
import type { CompletionMode, CompletionResult, CompletionTarget } from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CompletionSender — the one way this package sends a chat completion request and times it
//
//	Every subcommand goes through this class, so `completion`, `history`, and `benchmark` cannot
//	drift apart in how they talk to an endpoint or in what their timings mean.
//	The `openai` npm package is the single transport: nothing here builds a request body, parses
//	server-sent events, or reads a response body by hand.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Everything one call to `CompletionSender.send` needs. */
export type SendCompletionOptions = {
	/** The OpenAI client pointed at the endpoint under test. */
	readonly client: OpenAI;
	/** The model identifier to request. */
	readonly modelId: string;
	/** The full list of messages to send. */
	readonly messages: OpenAI.ChatCompletionMessageParam[];
	/** Whether to ask for the answer as it is written, or in one piece. */
	readonly mode: CompletionMode;
	/**
	 * Called with each piece of the answer as it arrives, so a subcommand that shows the answer
	 * to a person can write it out while it is being produced. Left out by the benchmark, which
	 * measures rather than shows.
	 */
	readonly writePiece?: (piece: string) => void;
};

/** The completion request a benchmark run uses, replaceable for deterministic tests. */
export type CompletionRequester = (modelId: string, prompt: string) => Promise<CompletionResult>;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CompletionSender
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Sends one chat completion request to an OpenAI-compatible endpoint and measures it. */
export class CompletionSender {
	/**
	 * Builds the OpenAI client every request of one run goes through.
	 *
	 * Retries are turned off, because a retried request would be timed as though it were the
	 * first one, which would make every measurement this package produces untrustworthy.
	 *
	 * @param target The endpoint to send requests to.
	 * @returns The client, ready to be handed to `send`.
	 */
	static createClient(target: CompletionTarget): OpenAI {
		return new OpenAI({
			baseURL: target.baseUrl,
			apiKey: target.apiKey,
			maxRetries: 0,
			timeout: target.timeoutMs,
		});
	}

	/**
	 * Sends one chat completion request in the requested mode and measures when its first and
	 * last character arrived.
	 *
	 * @param options The client, the model identifier, the messages, the mode, and where to write
	 * each piece of the answer as it arrives.
	 * @returns The answer and when its characters arrived.
	 * @throws {Error} If the endpoint returned no answer text at all.
	 */
	static async send(options: SendCompletionOptions): Promise<CompletionResult> {
		if (options.mode === 'streamed') {
			return await CompletionSender._sendStreamed(options);
		}
		return await CompletionSender._sendNostream(options);
	}

	/**
	 * Turns a caught error into one line of text, reporting a refusal from the endpoint in words
	 * rather than as a stack trace. In a cluster of volunteer devices the everyday reason a
	 * request fails is that no worker is currently offering the work, which is an answer and not
	 * a fault in the program that asked.
	 *
	 * @param error The error caught around one request.
	 * @returns The message to print and to record in the outcome.
	 */
	static describeFailure(error: unknown): string {
		if (error instanceof APIError) {
			return `HTTP ${error.status} (${String(error.code)}): ${error.message}`;
		}
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sends one streamed chat completion request, writing each piece out as it arrives rather
	 * than waiting for the whole answer, and measuring when its characters arrived.
	 *
	 * An endpoint that ignores `stream: true` and answers with one whole JSON body instead is
	 * still measured rather than reported as a failure: the `openai` npm package reads such a
	 * body as a stream carrying no pieces at all, so an empty stream is followed by one whole
	 * request, whose first and last character then arrive at the same moment. The extra request
	 * is only ever sent to an endpoint that produced nothing the first time.
	 *
	 * @param options The client, the model identifier, the messages, and where to write each piece.
	 * @returns The answer and when its characters arrived.
	 * @throws {Error} If neither the stream nor the whole request that follows it carried text.
	 */
	private static async _sendStreamed(options: SendCompletionOptions): Promise<CompletionResult> {
		const startedAt = performance.now();
		const { data: stream, response } = await options.client.chat.completions.create({
			model: options.modelId,
			messages: options.messages,
			stream: true,
		}).withResponse();
		const clusterTimeToFirstPieceMs = CompletionSender._readMsHeader(response, 'x-webai-time-to-first-piece-ms');

		let answer = '';
		let timeToFirstCharacterMs: number | undefined;
		for await (const chunk of stream) {
			const piece = chunk.choices[0]?.delta.content ?? '';
			if (piece === '') {
				continue;
			}
			if (timeToFirstCharacterMs === undefined) {
				timeToFirstCharacterMs = performance.now() - startedAt;
			}
			answer += piece;
			if (options.writePiece !== undefined) {
				options.writePiece(piece);
			}
		}
		const timeToLastCharacterMs = performance.now() - startedAt;

		if (answer === '') {
			return await CompletionSender._sendNostream(options);
		}

		return {
			answer,
			timeToFirstCharacterMs: timeToFirstCharacterMs ?? timeToLastCharacterMs,
			timeToLastCharacterMs,
			clusterGenerationTimeMs: undefined,
			clusterTimeToFirstPieceMs,
		};
	}

	/**
	 * Sends one whole chat completion request and measures how long the whole answer took. Its
	 * first and last character arrive at the same moment, because the endpoint sent the answer in
	 * one piece.
	 *
	 * @param options The client, the model identifier, the messages, and where to write the answer.
	 * @returns The answer and when its characters arrived.
	 * @throws {Error} If the endpoint returned no answer text.
	 */
	private static async _sendNostream(options: SendCompletionOptions): Promise<CompletionResult> {
		const startedAt = performance.now();
		const { data: completion, response } = await options.client.chat.completions.create({
			model: options.modelId,
			messages: options.messages,
		}).withResponse();
		const elapsedMs = performance.now() - startedAt;
		const answer = completion.choices[0]?.message.content ?? '';
		if (answer === '') {
			throw new Error('the endpoint returned no answer text');
		}
		if (options.writePiece !== undefined) {
			options.writePiece(answer);
		}

		return {
			answer,
			timeToFirstCharacterMs: elapsedMs,
			timeToLastCharacterMs: elapsedMs,
			clusterGenerationTimeMs: CompletionSender._readMsHeader(response, 'x-webai-generation-time-ms'),
			clusterTimeToFirstPieceMs: undefined,
		};
	}

	/**
	 * Reads one millisecond figure this project's own `consumer_openai` server reports in a
	 * response header, under Rule 3 of its OpenAI compatibility requirement.
	 *
	 * @param response The raw response the `openai` npm package's transport received. Typed by
	 * the one method this needs, rather than by that transport's own `Response` type, since the
	 * `openai` npm package resolves to a different `Response` type than the rest of this
	 * repository depending on which fetch implementation Node.js chose.
	 * @param headerName The header to read.
	 * @returns The header's value, or `undefined` when the endpoint sent no such header, or sent
	 * one this tool cannot read as a plain number — which every endpoint other than this
	 * project's own `consumer_openai` server does.
	 */
	private static _readMsHeader(response: { headers: { get(name: string): string | null } }, headerName: string): number | undefined {
		const rawValue = response.headers.get(headerName);
		if (rawValue === null) {
			return undefined;
		}
		const value = Number(rawValue);
		return Number.isFinite(value) ? value : undefined;
	}
}
