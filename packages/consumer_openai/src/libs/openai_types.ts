import { z } from 'zod';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiTypes — the request bodies this server accepts and the response bodies it returns
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Every field name in a response body below is spelled the way the OpenAI completion
// interface spells it on the connection, such as `finish_reason` and `owned_by`. Those
// spellings are part of the format an existing client reads, so they are not renamed to
// match this repository's own naming rules.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Request Bodies
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One message of a conversation, as a chat completion request carries it.
 *
 * The content must be a single piece of text. The OpenAI completion interface also allows a
 * list of content parts, for a request carrying images or audio, and such a request is
 * refused here rather than having its parts joined together, because a task in this cluster
 * carries one piece of text and nothing else.
 *
 * The `tool` role is refused for the same reason: this server ignores the tool settings of a
 * request, so a conversation containing the answer of a tool could not be continued sensibly.
 */
export const ChatCompletionMessageSchema = z.object({
	role: z.enum(['system', 'developer', 'user', 'assistant']),
	content: z.string(),
	name: z.string().optional(),
});
/** One message of a conversation, as a chat completion request carries it. */
export type ChatCompletionMessage = z.infer<typeof ChatCompletionMessageSchema>;

/**
 * The body of a request to `POST /v1/chat/completions`.
 *
 * Only the three fields named here are read. Every other field an OpenAI client may send —
 * `temperature`, `top_p`, `max_tokens`, `n`, `stop`, `tools`, `logprobs`, and the rest — is
 * accepted and then ignored, because a task in this cluster carries only a prompt and the
 * generation limits belong to the worker browser that runs the model. The schema therefore
 * deliberately does not refuse unknown fields.
 */
export const ChatCompletionRequestSchema = z.object({
	model: z.string().min(1),
	messages: z.array(ChatCompletionMessageSchema).min(1),
	stream: z.boolean().optional(),
});
/** The body of a request to `POST /v1/chat/completions`. */
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Response Bodies
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One answer inside a chat completion response.
 *
 * This server always returns exactly one, because one request runs one cluster task, and a
 * request asking for several answers has that setting ignored.
 */
export type ChatCompletionChoice = {
	index: number;
	message: { role: 'assistant'; content: string };
	logprobs: null;
	finish_reason: 'stop';
};

/**
 * The body returned by `POST /v1/chat/completions`.
 *
 * There is no `usage` field. The gateway reports no token counts to a consumer, so this
 * server has no counts to report and states none rather than inventing them.
 */
export type ChatCompletionResponse = {
	id: string;
	object: 'chat.completion';
	created: number;
	model: string;
	choices: ChatCompletionChoice[];
};

/** One model in the list returned by `GET /v1/models`. */
export type ModelDescription = {
	id: string;
	object: 'model';
	created: number;
	owned_by: string;
};

/** The body returned by `GET /v1/models`. */
export type ModelListResponse = {
	object: 'list';
	data: ModelDescription[];
};

/** The body returned by `GET /health`. */
export type HealthResponse = {
	ok: boolean;
	/** Whether this server currently holds a registered connection to the central gateway. */
	isGatewayConnected: boolean;
	/** How many requests are waiting for a cluster task to finish. */
	tasksInFlight: number;
};
