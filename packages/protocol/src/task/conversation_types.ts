import { z } from 'zod';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ConversationTypes — the conversation a language-model task carries, in place of one prompt
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Every name here is spelled the way this repository spells names, and not the way the OpenAI
// completion interface spells the same ideas on the connection. That interface's spellings belong
// in `packages/consumer_openai/src/api/openai_types.ts`, where they are part of a format an
// existing client reads and so cannot be renamed. This is this project's own protocol, so it uses
// this project's own naming.

/**
 * The largest number of messages one conversation may carry.
 *
 * A bound rather than a judgement about how long a conversation should be: every message travels
 * inside one gateway message on every submission, so an unbounded list is an unbounded frame.
 */
const maximumMessageCount = 1000;

/** The largest one message's content may be, in characters, matching `StagePayloadSchema`'s own text bound. */
const maximumContentLength = 100_000;

/**
 * One message of a conversation.
 *
 * The three roles are the three a chat template has slots for. The OpenAI completion interface also
 * has a `developer` role, which is its newer name for what it used to call `system`; a consumer
 * that receives one sends it here as `system`, because no chat template this project drives knows
 * a fourth name for that slot.
 */
export const ConversationMessageSchema = z.object({
	/** Who said this: the instructions, the caller, or the model. */
	role: z.enum(['system', 'user', 'assistant']),
	/** What was said. */
	content: z.string().max(maximumContentLength),
}).strict();
/** One message of a conversation. */
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

/**
 * The whole conversation a language-model task carries, in place of one piece of text.
 *
 * A task carried one prompt before this existed, and still may: `TaskInput` accepts either, so a
 * consumer with one prompt and nothing else to say submits a prompt. This shape exists for the
 * consumer that has more to say than one prompt can hold, such as several turns or a system
 * message.
 *
 * What this replaces is worth stating plainly, because the failure it removes is easy to miss.
 * Before it, a conversation was flattened into lines of `role: content` text and handed to the
 * model as a single user message, so the model saw one turn whose content happened to be a
 * transcript, and every chat template wrapped one set of turn markers around the whole thing. A
 * system message became a line of text inside a user turn. Carrying the messages as messages is
 * what lets each one reach the slot its chat template already has for it.
 */
export const ConversationInputSchema = z.object({
	/** The messages of the conversation, oldest first. */
	messages: z.array(ConversationMessageSchema).min(1).max(maximumMessageCount),
}).strict();
/** The whole conversation a language-model task carries, in place of one piece of text. */
export type ConversationInput = z.infer<typeof ConversationInputSchema>;
