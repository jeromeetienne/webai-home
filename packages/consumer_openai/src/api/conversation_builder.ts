import type { ConversationInput, ConversationMessage } from '@webai/protocol';
import type { ChatCompletionMessage } from './openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ConversationBuilder — turns a request's messages into the conversation a task carries
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds the `ConversationInput` a task carries, from the message list of a chat completion
 * request, for a model whose task type accepts a whole conversation rather than only one prompt
 * (see `TaskInputFactory.acceptsConversation` in `@webai/consumer-cli`).
 *
 * This is what `PromptFlattener` was standing in for on these models. Flattening joined every
 * message into one piece of text and handed a worker a single user turn to make sense of; this
 * keeps each message's own role instead, so a worker's chat template places it in the slot that
 * template already has for that role — a system message reaches the system slot rather than
 * becoming a line of text inside a user turn.
 */
export class ConversationBuilder {
	/**
	 * Builds the conversation to submit for one request.
	 *
	 * @param messages The messages of the request, in the order they were sent.
	 * @returns The conversation to submit as the task input.
	 */
	static build(messages: ChatCompletionMessage[]): ConversationInput {
		return {
			messages: messages.map(ConversationBuilder.messageOf),
		};
	}

	/**
	 * Turns one request message into the shape a task carries.
	 *
	 * The OpenAI completion interface's `developer` role is its newer name for what it used to
	 * call `system`. No chat template this project drives knows a fourth name for that slot, so a
	 * `developer` message is carried as `system` here, rather than reaching a worker under a role
	 * its chat template does not recognise.
	 *
	 * @param message One message of the request.
	 * @returns The same message, in the protocol's own shape.
	 */
	private static messageOf(message: ChatCompletionMessage): ConversationMessage {
		return {
			role: message.role === 'developer' ? 'system' : message.role,
			content: message.content,
		};
	}
}
