import type { ConversationInput } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiApiClient — talks to one local server that speaks the OpenAI-compatible API
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How long the model list request may take before it is given up on, in milliseconds. */
const modelListTimeoutMs = 10_000;

/**
 * One entry of the model list a server returns from `GET /v1/models`.
 *
 * Only the identifier is read here. Ollama and LM Studio each return more fields than this,
 * and neither set is part of what this worker relies on.
 */
type ModelListEntry = {
	/** The identifier a completion request names in its `model` field, such as `llama3.2:3b`. */
	id: string;
};

/** The answer to `GET /v1/models`, as both Ollama and LM Studio return it. */
type ModelListResponse = {
	/** The models the server currently offers. */
	data: ModelListEntry[];
};

/** The shape of one Chat Completions streaming event this client reads, and ignores the rest of. */
type ChatCompletionChunk = {
	choices?: {
		delta?: {
			content?: string;
		};
	}[];
};

/** One message of the request this client sends to the local server, in the shape it expects. */
type OutgoingMessage = {
	role: string;
	content: string;
};

/**
 * Talks to one locally running server that speaks the OpenAI-compatible API, such as Ollama or
 * LM Studio.
 *
 * The server is named by a base URL rather than chosen here, because which server a worker
 * talks to is decided by whoever starts the worker process. The client holds that base URL, so
 * it has state and its methods are instance methods.
 *
 * Confirmed live against a running Ollama instance, version 0.32.5, before this class was
 * written (see the de-risk gate recorded in
 * https://github.com/webai-at-home/webai-at-home/issues/103): `POST /v1/chat/completions` with
 * `stream: true` delivers one piece of the answer per streamed event, each carrying its piece in
 * `choices[0].delta.content`, and ends with an event whose `finish_reason` is set followed by a
 * literal `data: [DONE]` line.
 */
export class OpenaiApiClient {
	/**
	 * @param baseUrl The base URL of the local server's OpenAI-compatible API, without a
	 * trailing slash, such as `http://localhost:11434/v1`.
	 */
	constructor(private readonly baseUrl: string) {
	}

	/**
	 * Lists the models the local server currently offers.
	 *
	 * @returns The model identifiers, in the order the server listed them.
	 * @throws If the server cannot be reached, answers with a failure status, or answers with
	 * something that is not a model list.
	 */
	async listModelIds(): Promise<string[]> {
		const response = await fetch(`${this.baseUrl}/models`, {
			signal: AbortSignal.timeout(modelListTimeoutMs),
		}).catch((error: unknown) => {
			throw new Error(`The server at ${this.baseUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (response.ok === false) {
			throw new Error(`The server at ${this.baseUrl} answered its model list with status ${response.status}`);
		}
		const body = await response.json() as ModelListResponse;
		if (Array.isArray(body.data) === false) {
			throw new Error(`The server at ${this.baseUrl} answered its model list without a "data" array`);
		}
		return body.data.map((entry) => entry.id);
	}

	/**
	 * Starts a Chat Completions request and returns the pieces of the answer as they stream in.
	 *
	 * @param modelId The model to ask for, exactly as the local server names it.
	 * @param promptOrConversation The prompt to answer, or the whole conversation to continue when
	 * the task carries one instead of a single prompt.
	 * @param abortController Aborts the request when the answer is no longer wanted. The stream's
	 * own `cancel` calls this, so cancelling the reader stops the request to the local server
	 * rather than only stopping this side from reading it.
	 * @returns A stream of the pieces of text the model produces, in order.
	 * @throws If the server cannot be reached, or answers with a failure status.
	 */
	async chatCompletionStream(
		modelId: string,
		promptOrConversation: string | ConversationInput,
		abortController: AbortController,
	): Promise<ReadableStream<string>> {
		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: modelId,
				stream: true,
				messages: OpenaiApiClient.messagesOf(promptOrConversation),
			}),
			signal: abortController.signal,
		}).catch((error: unknown) => {
			throw new Error(`The server at ${this.baseUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (response.ok === false) {
			throw new Error(`The server at ${this.baseUrl} answered the chat completion with status ${response.status}`);
		}
		if (response.body === null) {
			throw new Error(`The server at ${this.baseUrl} answered the chat completion with no body`);
		}
		return OpenaiApiClient.textPiecesOf(response.body, abortController);
	}

	/**
	 * Builds the message list to send to the local server, from either a prompt or a conversation.
	 *
	 * A single prompt becomes the one user message this client has always sent. A conversation
	 * becomes its messages, each carrying the role it was given, so the local server's own chat
	 * template can place a system message and an earlier assistant turn where they belong instead
	 * of receiving one user message whose content happens to be a transcript.
	 *
	 * Tool calls and tool results are not read yet: nothing submits a conversation carrying them
	 * ahead of the tool calling support tracked in issue #114, which is what will read them here.
	 *
	 * @param promptOrConversation The prompt or conversation submitted with the task.
	 * @returns The message list to send in the request body.
	 */
	private static messagesOf(promptOrConversation: string | ConversationInput): OutgoingMessage[] {
		if (typeof promptOrConversation === 'string') {
			return [{ role: 'user', content: promptOrConversation }];
		}
		return promptOrConversation.messages.map((message) => ({ role: message.role, content: message.content ?? '' }));
	}

	/**
	 * Reads a Chat Completions streaming response body and delivers the text piece of each event,
	 * as `server-sent events` carrying the shape of {@link ChatCompletionChunk}.
	 *
	 * @param body The response body, a stream of raw bytes.
	 * @param abortController Aborted when the returned stream is cancelled, so a reader giving up
	 * on the answer stops the request rather than only stopping its own read.
	 * @returns A stream of the pieces of text the events carry, skipping events that carry none.
	 */
	private static textPiecesOf(body: ReadableStream<Uint8Array>, abortController: AbortController): ReadableStream<string> {
		const bodyReader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		return new ReadableStream<string>({
			// This must not return until it has enqueued a piece, closed the stream, or failed.
			// A pull that returns having done none of the three is never called again while a
			// read is outstanding, which deadlocks the stream: the reader waits for a piece that
			// only another pull could deliver. Reading more bytes from the body is therefore part
			// of this loop rather than a step that ends the pull.
			async pull(controller) {
				for (;;) {
					const newlineIndex = buffer.indexOf('\n');
					if (newlineIndex === -1) {
						const { value, done } = await bodyReader.read();
						if (done) {
							controller.close();
							return;
						}
						buffer += decoder.decode(value, { stream: true });
						continue;
					}
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (line.startsWith('data:') === false) {
						continue;
					}
					const data = line.slice('data:'.length).trim();
					if (data === '[DONE]') {
						controller.close();
						return;
					}
					if (data === '') {
						continue;
					}
					const chunk = JSON.parse(data) as ChatCompletionChunk;
					const content = chunk.choices?.[0]?.delta?.content;
					if (typeof content === 'string' && content !== '') {
						controller.enqueue(content);
						return;
					}
				}
			},
			cancel() {
				abortController.abort();
				return bodyReader.cancel().catch(() => undefined);
			},
		});
	}
}
