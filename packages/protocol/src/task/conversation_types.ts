import { z } from 'zod';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ConversationTypes — the conversation a language-model task carries, in place of one prompt
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Every name here is spelled the way this repository spells names, and not the way the OpenAI
// completion interface spells the same ideas on the connection. That interface's spellings, such
// as `tool_calls` and `tool_call_id`, belong in
// `packages/consumer_openai/src/api/openai_types.ts`, where they are part of a format an existing
// client reads and so cannot be renamed. This is this project's own protocol, so it uses this
// project's own naming.

/**
 * The largest number of messages one conversation may carry.
 *
 * A bound rather than a judgement about how long a conversation should be: every message travels
 * inside one gateway message on every submission, so an unbounded list is an unbounded frame.
 */
const maximumMessageCount = 1000;

/** The largest one message's content may be, in characters, matching `StagePayloadSchema`'s own text bound. */
const maximumContentLength = 100_000;

/** The largest number of tools one conversation may declare. */
const maximumToolCount = 128;

/** The largest number of tool calls one assistant message may ask for. */
const maximumToolCallCount = 32;

/** The largest a tool call's written arguments may be, in characters. */
const maximumToolArgumentsLength = 100_000;

/**
 * One tool call an assistant message asks for.
 *
 * The arguments are carried as the text the model wrote rather than as a parsed object, because
 * that text is what the model actually produced and a model can write arguments that are not
 * valid JSON. Whoever runs the tool decides what to do about that; nothing on the way there has
 * to guess, and nothing silently repairs it.
 */
export const ToolCallSchema = z.object({
	/** This call's own identifier, which the `tool` message answering it names in `toolCallId`. */
	id: z.string().min(1).max(200),
	/** The name of the tool being asked for, as declared in {@link ToolDeclarationSchema}. */
	name: z.string().min(1).max(200),
	/** The arguments the model wrote, as it wrote them. */
	argumentsJson: z.string().max(maximumToolArgumentsLength),
}).strict();
/** One tool call an assistant message asks for. */
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * One tool a conversation declares as available.
 *
 * The tool runs in the calling program, never in the volunteer's browser. Running a caller's tool
 * on a volunteer device would issue requests from a stranger's machine, network address, and
 * signed-in browser session, which is a security problem before it is an engineering one. This
 * declaration therefore describes a tool rather than carrying anything that could run it.
 */
export const ToolDeclarationSchema = z.object({
	/** The name the model uses when it asks for this tool. */
	name: z.string().min(1).max(200),
	/** What the tool does, in the words the model reads when deciding whether to ask for it. */
	description: z.string().max(2000).optional(),
	/** The JSON Schema describing the arguments this tool takes, passed to the model unread. */
	parametersJsonSchema: z.record(z.string(), z.unknown()).optional(),
}).strict();
/** One tool a conversation declares as available. */
export type ToolDeclaration = z.infer<typeof ToolDeclarationSchema>;

/**
 * One message of a conversation.
 *
 * The four roles are the four a chat template has slots for. The OpenAI completion interface also
 * has a `developer` role, which is its newer name for what it used to call `system`; a consumer
 * that receives one sends it here as `system`, because no chat template this project drives knows
 * a fourth name for that slot.
 */
export const ConversationMessageSchema = z.object({
	/** Who said this: the instructions, the caller, the model, or a tool answering the model. */
	role: z.enum(['system', 'user', 'assistant', 'tool']),
	/**
	 * What was said.
	 *
	 * Absent only on an assistant message that asks for a tool and says nothing else, which is the
	 * one kind of message that carries no content of its own.
	 */
	content: z.string().max(maximumContentLength).optional(),
	/**
	 * The tools this assistant message asks for, on the message that asks for them.
	 *
	 * No worker reads this yet. It is defined here so that the protocol version is raised once for
	 * both conversation history and tool calling rather than once for each, and it is not sent by
	 * any consumer in this project until tool calling is built (see issue #114).
	 */
	toolCalls: z.array(ToolCallSchema).max(maximumToolCallCount).optional(),
	/**
	 * Which tool call this message answers, on a message whose role is `tool`.
	 *
	 * Not read yet, for the same reason as {@link toolCalls}.
	 */
	toolCallId: z.string().min(1).max(200).optional(),
}).strict();
/** One message of a conversation. */
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

/** How a conversation asks the model to choose among the tools it declared. */
export const ToolChoiceSchema = z.union([
	z.enum(['auto', 'none', 'required']),
	z.object({
		name: z.string().min(1).max(200),
	}).strict(),
]);
/** How a conversation asks the model to choose among the tools it declared. */
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

/**
 * The whole conversation a language-model task carries, in place of one piece of text.
 *
 * A task carried one prompt before this existed, and still may: `TaskInput` accepts either, so a
 * consumer with one prompt and nothing else to say submits a prompt. This shape exists for the
 * consumer that has more to say than one prompt can hold — several turns, a system message, or,
 * once tool calling is built, the tools it has and the results it has already gathered.
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
	/**
	 * The tools available to the model.
	 *
	 * No worker reads this yet; see {@link ConversationMessageSchema.shape.toolCalls} for why it is
	 * defined ahead of being read.
	 */
	tools: z.array(ToolDeclarationSchema).max(maximumToolCount).optional(),
	/** How the model should choose among {@link tools}. Not read yet, for the same reason. */
	toolChoice: ToolChoiceSchema.optional(),
}).strict();
/** The whole conversation a language-model task carries, in place of one piece of text. */
export type ConversationInput = z.infer<typeof ConversationInputSchema>;
