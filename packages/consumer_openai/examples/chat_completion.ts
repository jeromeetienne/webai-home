#!/usr/bin/env -S npx tsx

// npm imports
import { Command } from 'commander';
import OpenAI, { APIError } from 'openai';

// local imports
import { taskTypeNamesAcceptingConversation } from '@webai/consumer-cli';
import { ModelCatalog } from '../src/api/model_catalog.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatCompletion — tests text completion on every model the cluster offers, in one run
//
//	Run with:
//	  ./chat_completion.ts text_completion --streamed --model llm_qwen3_0_6b_sharded
//	  ./chat_completion.ts conversation_history --model llm_llama3_2_3b_full
//	or, from the workspace:
//	  npm run example:chat_completion --workspace @webai/consumer-openai -- text_completion -m all
//
//	`text_completion` sends one prompt per model. Every model of `ModelCatalog.modelIds` has its
//	own default prompt: `5` for `dev_formula`, which accepts only a number, and a plain question
//	for every other model. `conversation_history` instead sends the two-turn conversation
//	`examples/chat_completion_history_llm_qwen3_5_0_8b_full.ts` and
//	`examples/chat_completion_history_llm_llama3_2_3b_full.ts` already show by hand, and checks
//	that the second turn's answer recalls what the first turn said, across every model in
//	`taskTypeNamesAcceptingConversation` — the only models whose task type accepts a whole
//	conversation rather than only one prompt.
//
//	`-m/--model` accepts one model identifier, a comma-separated list of identifiers, a pattern
//	such as `llm_*`, `all`, or `list` to print the model identifiers and test nothing. Neither
//	`-s/--streamed` nor `--nostream` given tests both modes, which is what makes a bare
//	subcommand the whole sweep across every model and every mode it applies to. Each pair is
//	tested one at a time; a failure is reported and the run carries on with the next pair, the
//	same way the single-model examples in this directory already report a failure in words rather
//	than as a stack trace.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One mode a chat completion request can be tested in. */
type CompletionMode = 'nostream' | 'streamed';

/** Every mode this example knows how to test, in the order they run for one model. */
const completionModes: readonly CompletionMode[] = ['nostream', 'streamed'];

/** The options shared by both subcommands, before either adds its own. */
type RawSharedOptions = {
	/** One model identifier, a pattern such as `llm_*`, `all`, or `list`. */
	model: string;
	/** Set when `-s/--streamed` was given. */
	streamed?: boolean;
	/** Set when `--nostream` was given. */
	nostream?: boolean;
	/** The `consumer_openai` server to reach. */
	base_url: string;
	/** How long one request may take before it is given up on, still as text. */
	timeout_ms: string;
};

/** The `text_completion` subcommand's own options, exactly as commander parses them. */
type RawTextCompletionOptions = RawSharedOptions & {
	/** The prompt to send instead of each model's own default prompt. */
	prompt?: string;
};

/** The `conversation_history` subcommand's own options, exactly as commander parses them. */
type RawConversationHistoryOptions = RawSharedOptions;

/** How one tested model and mode pair turned out. */
type TestStatus = 'ok' | 'failed' | 'skipped';

/** What testing one model and one mode produced. */
type TestOutcome = {
	/** The model identifier tested. */
	readonly modelId: string;
	/** The mode tested. */
	readonly mode: CompletionMode;
	/**
	 * `ok` once the model answered with usable text, `failed` once it did not, and `skipped`
	 * for a pairing known ahead of the request not to work, such as `dev_formula` asked to
	 * stream, so that a permanent, documented restriction of the cluster does not read as a
	 * failure of this run.
	 */
	readonly status: TestStatus;
	/**
	 * Elapsed time, in milliseconds, from the request being sent until the first character
	 * arrived. Equal to `timeToLastCharacterMs` in the nostream mode. `0` when skipped.
	 */
	readonly timeToFirstCharacterMs: number;
	/** Elapsed time, in milliseconds, from the request being sent until the final character arrived. `0` when skipped. */
	readonly timeToLastCharacterMs: number;
	/** The number of characters of the answer, `0` when not `ok`. */
	readonly characterCount: number;
	/** The raw answer text, already printed as it was produced. Empty when not `ok`. */
	readonly answer: string;
	/** Why the pair failed or was skipped, `undefined` on success. */
	readonly failureMessage: string | undefined;
};

/** What sending one request, given a full list of messages, produced. */
type CompletionResult = {
	/** The complete assistant answer, concatenated from every streamed piece in the streamed mode. */
	readonly answer: string;
	/**
	 * Elapsed time, in milliseconds, from the request being sent until the first character
	 * arrived. Equal to `timeToLastCharacterMs` in the nostream mode.
	 */
	readonly timeToFirstCharacterMs: number;
	/** Elapsed time, in milliseconds, from the request being sent until the final character arrived. */
	readonly timeToLastCharacterMs: number;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatCompletion
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Tests text completion on every model the cluster offers, streamed and nostream, in one run. */
class ChatCompletion {
	/** The prompt sent to `dev_formula`, which accepts only a number and answers with a number. */
	private static readonly _devFormulaPrompt = '5';

	/** The prompt sent to every model other than `dev_formula`. */
	private static readonly _defaultLanguagePrompt = 'What is the capital of France?';

	/**
	 * The first turn of `conversation_history`, stating a fact and nothing else, the same
	 * message `examples/chat_completion_history_llm_llama3_2_3b_full.ts` sends.
	 */
	private static readonly _historyFirstMessage = 'My name is Ada and my favorite programming language is Lisp. Please just say hello back.';

	/**
	 * The second turn of `conversation_history`, asking a question that can only be answered by
	 * recalling what the first turn said.
	 */
	private static readonly _historySecondMessage = 'What is my name, and what is my favorite programming language? Answer in one short sentence.';

	/**
	 * Runs the `chat_completion` example: parses the command line and dispatches to
	 * `text_completion` or `conversation_history`, its two subcommands.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 * @returns Nothing, once the subcommand has finished. Sets `process.exitCode` to `1` when
	 * the command line itself was unusable, such as an `-m/--model` pattern matching nothing,
	 * reported in words rather than as a stack trace, the same way `Cli.run` in
	 * `@webai/consumer-cli` reports it.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Command();
		program.name('chat_completion').description('Tests text completion on every model the cluster offers.');

		program
			.command('text_completion')
			.description('Sends one chat completion request per model and per mode, and reports which ones answered.')
			.option(
				'-m, --model <name>',
				'model identifier, a comma-separated list of identifiers, a pattern such as llm_*, all, or list to print the model identifiers',
				'all',
			)
			.option('-s, --streamed', 'test the streamed mode only')
			.option('--nostream', 'test the nostream mode only')
			.option('-u, --base_url <url>', 'the consumer_openai server to reach', process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1')
			.option('-p, --prompt <text>', "the prompt to send instead of each model's own default prompt")
			.option('--timeout_ms <number>', 'how long one request may take before it is given up on', '600000')
			.action(async (rawOptions: RawTextCompletionOptions) => {
				await ChatCompletion._runTextCompletion(rawOptions);
			});

		program
			.command('conversation_history')
			.description(
				"Sends a two-turn conversation to a model that accepts one, and checks that the second turn's answer recalls what the first turn said.",
			)
			.option(
				'-m, --model <name>',
				`model identifier, a comma-separated list of identifiers, a pattern, all, or list to print the model identifiers — only ${taskTypeNamesAcceptingConversation.join(' and ')} accept a whole conversation`,
				'all',
			)
			.option('-s, --streamed', 'test the streamed mode only')
			.option('--nostream', 'test the nostream mode only')
			.option('-u, --base_url <url>', 'the consumer_openai server to reach', process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1')
			.option('--timeout_ms <number>', 'how long one request may take before it is given up on', '600000')
			.action(async (rawOptions: RawConversationHistoryOptions) => {
				await ChatCompletion._runConversationHistory(rawOptions);
			});

		try {
			await program.parseAsync(args, { from: 'user' });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = 1;
		}
	}

	/**
	 * Runs the `text_completion` subcommand: tests every requested model and mode pair, one at a
	 * time, prints one line per pair, and finishes with a summary table.
	 *
	 * `-m/--model list` is handled here, before anything else, as a request to print the model
	 * identifiers `ModelCatalog.modelIds` offers rather than to test any of them, so it needs
	 * neither `-u/--base_url` to answer nor a gateway to be reachable.
	 *
	 * @param rawOptions The subcommand's own options, exactly as commander parsed them.
	 * @returns Nothing. Sets `process.exitCode` to `1` when any pair failed.
	 */
	private static async _runTextCompletion(rawOptions: RawTextCompletionOptions): Promise<void> {
		if (rawOptions.model === 'list') {
			ChatCompletion._printModelIds(ModelCatalog.modelIds);
			return;
		}

		const modelIds = ChatCompletion._resolveModelIds(rawOptions.model, ModelCatalog.modelIds);
		const modes = ChatCompletion._resolveModes(rawOptions);
		const timeoutMs = ChatCompletion._parseTimeoutMs(rawOptions.timeout_ms);

		const client = new OpenAI({
			baseURL: rawOptions.base_url,
			apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
			maxRetries: 0,
			timeout: timeoutMs,
		});

		const outcomes: TestOutcome[] = [];
		for (const modelId of modelIds) {
			const prompt = rawOptions.prompt ?? ChatCompletion._defaultPromptFor(modelId);
			for (const mode of modes) {
				const outcome = await ChatCompletion._testTextCompletion(client, modelId, mode, prompt);
				outcomes.push(outcome);
				ChatCompletion._printOutcome(outcome);
			}
		}

		ChatCompletion._printSummary(outcomes);
		if (outcomes.some((outcome) => outcome.status === 'failed')) {
			process.exitCode = 1;
		}
	}

	/**
	 * Runs the `conversation_history` subcommand: tests every requested model and mode pair, one
	 * at a time, prints the two turns and one analysis line per pair, and finishes with a
	 * summary table.
	 *
	 * `-m/--model list` is handled here, before anything else, the same way it is in
	 * `_runTextCompletion`, printing `taskTypeNamesAcceptingConversation` rather than every model
	 * on offer, since only those models accept a whole conversation.
	 *
	 * @param rawOptions The subcommand's own options, exactly as commander parsed them.
	 * @returns Nothing. Sets `process.exitCode` to `1` when any pair failed.
	 */
	private static async _runConversationHistory(rawOptions: RawConversationHistoryOptions): Promise<void> {
		if (rawOptions.model === 'list') {
			ChatCompletion._printModelIds(taskTypeNamesAcceptingConversation);
			return;
		}

		const modelIds = ChatCompletion._resolveModelIds(rawOptions.model, taskTypeNamesAcceptingConversation);
		const modes = ChatCompletion._resolveModes(rawOptions);
		const timeoutMs = ChatCompletion._parseTimeoutMs(rawOptions.timeout_ms);

		const client = new OpenAI({
			baseURL: rawOptions.base_url,
			apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
			maxRetries: 0,
			timeout: timeoutMs,
		});

		const outcomes: TestOutcome[] = [];
		for (const modelId of modelIds) {
			for (const mode of modes) {
				const outcome = await ChatCompletion._testConversationHistory(client, modelId, mode);
				outcomes.push(outcome);
				ChatCompletion._printOutcome(outcome);
			}
		}

		ChatCompletion._printSummary(outcomes);
		if (outcomes.some((outcome) => outcome.status === 'failed')) {
			process.exitCode = 1;
		}
	}

	/**
	 * Prints every model identifier of `universe`, one per line, for `-m/--model list`.
	 *
	 * @param universe The model identifiers to print.
	 * @returns Nothing.
	 */
	private static _printModelIds(universe: readonly string[]): void {
		for (const modelId of universe) {
			console.log(modelId);
		}
	}

	/**
	 * Expands `-m/--model` into the model identifiers to test.
	 *
	 * @param pattern `all`; one model identifier; a pattern with `*` standing for any run of
	 * characters; or a comma-separated list of any mix of the two. Never `list`, which the
	 * caller handles before this is called.
	 * @param universe The model identifiers this subcommand can test.
	 * @returns The matching model identifiers, in `universe` order, without duplicates.
	 */
	private static _resolveModelIds(pattern: string, universe: readonly string[]): string[] {
		if (pattern === 'all') {
			return [...universe];
		}
		const parts = pattern
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part !== '');
		const matchedModelIds = new Set<string>();
		for (const part of parts) {
			for (const modelId of ChatCompletion._matchModelIds(part, universe)) {
				matchedModelIds.add(modelId);
			}
		}
		return universe.filter((modelId) => matchedModelIds.has(modelId));
	}

	/**
	 * Matches one part of `-m/--model`, after it has been split on commas, against the model
	 * identifiers this subcommand can test.
	 *
	 * @param part One model identifier, or a pattern with `*` standing for any run of characters.
	 * @param universe The model identifiers this subcommand can test.
	 * @returns The matching model identifiers.
	 */
	private static _matchModelIds(part: string, universe: readonly string[]): string[] {
		const regularExpressionSource = part
			.split('*')
			.map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*');
		const regularExpression = new RegExp(`^${regularExpressionSource}$`);
		const matches = universe.filter((modelId) => regularExpression.test(modelId));
		if (matches.length === 0) {
			throw new Error(`No model matches "${part}". The models on offer are: ${universe.join(', ')}`);
		}
		return matches;
	}

	/**
	 * Resolves which modes to test from `-s/--streamed` and `--nostream`.
	 *
	 * @param rawOptions Either subcommand's own options.
	 * @returns Both modes when neither flag is given, or when both are; otherwise the one flag given.
	 */
	private static _resolveModes(rawOptions: RawSharedOptions): readonly CompletionMode[] {
		const streamedOnly = rawOptions.streamed === true && rawOptions.nostream !== true;
		const nostreamOnly = rawOptions.nostream === true && rawOptions.streamed !== true;
		if (streamedOnly === true) {
			return ['streamed'];
		}
		if (nostreamOnly === true) {
			return ['nostream'];
		}
		return completionModes;
	}

	/**
	 * Converts `--timeout_ms` into a number, once, for either subcommand.
	 *
	 * @param rawTimeoutMs The option exactly as commander parsed it, still as text.
	 * @returns The timeout in milliseconds.
	 */
	private static _parseTimeoutMs(rawTimeoutMs: string): number {
		const timeoutMs = Number(rawTimeoutMs);
		if (Number.isFinite(timeoutMs) === false) {
			throw new Error(`--timeout_ms must be a number, got "${rawTimeoutMs}"`);
		}
		return timeoutMs;
	}

	/**
	 * The default prompt for one model, for `text_completion`.
	 *
	 * @param modelId The model identifier.
	 * @returns `5` for `dev_formula`, and a plain question for every other model.
	 */
	private static _defaultPromptFor(modelId: string): string {
		if (modelId === 'dev_formula') {
			return ChatCompletion._devFormulaPrompt;
		}
		return ChatCompletion._defaultLanguagePrompt;
	}

	/**
	 * Tests one model and one mode for `text_completion`: sends the one prompt, and turns either
	 * the answer or the failure into a `TestOutcome`.
	 *
	 * `dev_formula` asked to stream is skipped rather than sent, because
	 * `TaskInputFactory.createTaskInput` in `@webai/consumer-cli` refuses it outright — the
	 * `dev_formula` task answers with one number, so it cannot produce its answer in pieces.
	 * That is a permanent, documented restriction rather than something this run could ever
	 * fix, so it is reported apart from an actual failure.
	 *
	 * @param client The OpenAI client pointed at the `consumer_openai` server under test.
	 * @param modelId The model identifier to request.
	 * @param mode Whether to ask for the answer as it is written, or in one piece.
	 * @param prompt The single user message to send.
	 * @returns What happened.
	 */
	private static async _testTextCompletion(client: OpenAI, modelId: string, mode: CompletionMode, prompt: string): Promise<TestOutcome> {
		if (modelId === 'dev_formula' && mode === 'streamed') {
			return {
				modelId,
				mode,
				status: 'skipped',
				timeToFirstCharacterMs: 0,
				timeToLastCharacterMs: 0,
				characterCount: 0,
				answer: '',
				failureMessage: 'the dev_formula task answers with one number, so it cannot produce its answer in pieces',
			};
		}

		const startedAt = performance.now();
		try {
			const messages: OpenAI.ChatCompletionMessageParam[] = [
				{
					role: 'user',
					content: prompt,
				},
			];
			const result = await ChatCompletion._sendCompletion(client, modelId, messages, mode, mode);
			return {
				modelId,
				mode,
				status: 'ok',
				timeToFirstCharacterMs: result.timeToFirstCharacterMs,
				timeToLastCharacterMs: result.timeToLastCharacterMs,
				characterCount: result.answer.length,
				answer: result.answer,
				failureMessage: undefined,
			};
		} catch (error: unknown) {
			const elapsedMs = performance.now() - startedAt;
			return {
				modelId,
				mode,
				status: 'failed',
				timeToFirstCharacterMs: elapsedMs,
				timeToLastCharacterMs: elapsedMs,
				characterCount: 0,
				answer: '',
				failureMessage: ChatCompletion._describeFailure(error),
			};
		}
	}

	/**
	 * Tests one model and one mode for `conversation_history`: sends `_historyFirstMessage`, then
	 * sends `_historySecondMessage` with the first turn's own answer carried along with it, the
	 * way `examples/chat_completion_history_llm_llama3_2_3b_full.ts` shows by hand, and checks
	 * that the second answer recalls both facts the first turn stated.
	 *
	 * @param client The OpenAI client pointed at the `consumer_openai` server under test.
	 * @param modelId The model identifier to request.
	 * @param mode Whether to ask for each turn's answer as it is written, or in one piece.
	 * @returns What happened. The timings and character count are the second turn's own, since
	 * that is the request whose latency and recall this subcommand measures.
	 */
	private static async _testConversationHistory(client: OpenAI, modelId: string, mode: CompletionMode): Promise<TestOutcome> {
		const startedAt = performance.now();
		try {
			const firstMessages: OpenAI.ChatCompletionMessageParam[] = [
				{
					role: 'user',
					content: ChatCompletion._historyFirstMessage,
				},
			];
			const firstTurn = await ChatCompletion._sendCompletion(client, modelId, firstMessages, mode, 'turn 1');

			const secondMessages: OpenAI.ChatCompletionMessageParam[] = [
				{
					role: 'user',
					content: ChatCompletion._historyFirstMessage,
				},
				{
					role: 'assistant',
					content: firstTurn.answer,
				},
				{
					role: 'user',
					content: ChatCompletion._historySecondMessage,
				},
			];
			const secondTurn = await ChatCompletion._sendCompletion(client, modelId, secondMessages, mode, 'turn 2');

			const secondAnswerLower = secondTurn.answer.toLowerCase();
			const recalledName = secondAnswerLower.includes('ada');
			const recalledLanguage = secondAnswerLower.includes('lisp');
			if (recalledName === false || recalledLanguage === false) {
				throw new Error(`the second turn's answer did not recall both facts the first turn stated: "${secondTurn.answer}"`);
			}

			return {
				modelId,
				mode,
				status: 'ok',
				timeToFirstCharacterMs: secondTurn.timeToFirstCharacterMs,
				timeToLastCharacterMs: secondTurn.timeToLastCharacterMs,
				characterCount: secondTurn.answer.length,
				answer: secondTurn.answer,
				failureMessage: undefined,
			};
		} catch (error: unknown) {
			const elapsedMs = performance.now() - startedAt;
			return {
				modelId,
				mode,
				status: 'failed',
				timeToFirstCharacterMs: elapsedMs,
				timeToLastCharacterMs: elapsedMs,
				characterCount: 0,
				answer: '',
				failureMessage: ChatCompletion._describeFailure(error),
			};
		}
	}

	/**
	 * Sends one chat completion request in the requested mode, printing the answer, labelled, as
	 * it is produced.
	 *
	 * @param client The OpenAI client pointed at the `consumer_openai` server under test.
	 * @param modelId The model identifier to request.
	 * @param messages The full list of messages to send.
	 * @param mode Whether to ask for the answer as it is written, or in one piece.
	 * @param label What to print before the answer, such as `nostream`, `streamed`, `turn 1`, or `turn 2`.
	 * @returns The answer and when its characters arrived.
	 */
	private static async _sendCompletion(
		client: OpenAI,
		modelId: string,
		messages: OpenAI.ChatCompletionMessageParam[],
		mode: CompletionMode,
		label: string,
	): Promise<CompletionResult> {
		if (mode === 'streamed') {
			return await ChatCompletion._sendStreamed(client, modelId, messages, label);
		}
		return await ChatCompletion._sendNostream(client, modelId, messages, label);
	}

	/**
	 * Sends one streamed chat completion request, writing each piece to standard output as it
	 * arrives rather than waiting for the whole answer, the same way
	 * `examples/chat_completion_streamed_llm_qwen3_0_6b_sharded.ts` shows a streamed answer being
	 * written, and measures when its characters arrived.
	 *
	 * @param client The OpenAI client pointed at the `consumer_openai` server under test.
	 * @param modelId The model identifier to request.
	 * @param messages The full list of messages to send.
	 * @param label What to print before the answer.
	 * @returns The outcome, successful once at least one chunk carried answer text.
	 */
	private static async _sendStreamed(
		client: OpenAI,
		modelId: string,
		messages: OpenAI.ChatCompletionMessageParam[],
		label: string,
	): Promise<CompletionResult> {
		const startedAt = performance.now();
		const stream = await client.chat.completions.create({
			model: modelId,
			messages,
			stream: true,
		});

		process.stdout.write(`${label}: `);
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
			process.stdout.write(piece);
		}
		process.stdout.write('\n');
		const timeToLastCharacterMs = performance.now() - startedAt;
		if (answer === '') {
			throw new Error('the stream carried no answer text');
		}

		return {
			answer,
			timeToFirstCharacterMs: timeToFirstCharacterMs ?? timeToLastCharacterMs,
			timeToLastCharacterMs,
		};
	}

	/**
	 * Sends one nostream chat completion request and measures how long the whole answer took.
	 *
	 * @param client The OpenAI client pointed at the `consumer_openai` server under test.
	 * @param modelId The model identifier to request.
	 * @param messages The full list of messages to send.
	 * @param label What to print before the answer.
	 * @returns The outcome, successful once the answer carries text.
	 */
	private static async _sendNostream(
		client: OpenAI,
		modelId: string,
		messages: OpenAI.ChatCompletionMessageParam[],
		label: string,
	): Promise<CompletionResult> {
		const startedAt = performance.now();
		const completion = await client.chat.completions.create({
			model: modelId,
			messages,
		});
		const elapsedMs = performance.now() - startedAt;
		const answer = completion.choices[0]?.message.content ?? '';
		if (answer === '') {
			throw new Error('the answer carried no text');
		}
		console.log(`${label}: ${answer}`);

		return {
			answer,
			timeToFirstCharacterMs: elapsedMs,
			timeToLastCharacterMs: elapsedMs,
		};
	}

	/**
	 * Turns a caught error into one line of text, reporting a refusal from the server in words
	 * rather than as a stack trace, the same way the single-model examples in this directory do.
	 *
	 * @param error The error caught around one request.
	 * @returns The message to print and to record in the outcome.
	 */
	private static _describeFailure(error: unknown): string {
		if (error instanceof APIError) {
			return `HTTP ${error.status} (${String(error.code)}): ${error.message}`;
		}
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}

	/**
	 * Prints the analysis line for one tested model and mode pair. The raw answer, or the two
	 * turns of a conversation, have already been printed by `_sendStreamed` or `_sendNostream` as
	 * they were produced, so this line reads as commentary on text already shown rather than
	 * repeating it.
	 *
	 * @param outcome The outcome to print.
	 * @returns Nothing.
	 */
	private static _printOutcome(outcome: TestOutcome): void {
		if (outcome.status === 'skipped') {
			console.log(`${outcome.modelId} (${outcome.mode}): skipped — ${outcome.failureMessage}`);
			return;
		}
		const timings = `first character in ${Math.round(outcome.timeToFirstCharacterMs)} ms, last character in ${Math.round(outcome.timeToLastCharacterMs)} ms, ${outcome.characterCount} characters`;
		const line = `${outcome.modelId} (${outcome.mode}): ${outcome.status} — ${timings}`;
		if (outcome.status === 'ok') {
			console.log(line);
		} else {
			console.error(`${line} — ${outcome.failureMessage}`);
		}
	}

	/**
	 * Prints the summary table at the end of a run.
	 *
	 * @param outcomes Every pair tested, in the order they were tested.
	 * @returns Nothing.
	 */
	private static _printSummary(outcomes: TestOutcome[]): void {
		console.log('');
		console.log('Summary:');
		for (const outcome of outcomes) {
			console.log(`  ${outcome.modelId} (${outcome.mode}): ${outcome.status}`);
		}
		const failureCount = outcomes.filter((outcome) => outcome.status === 'failed').length;
		const skippedCount = outcomes.filter((outcome) => outcome.status === 'skipped').length;
		const passedCount = outcomes.length - failureCount - skippedCount;
		console.log('');
		console.log(`${passedCount}/${outcomes.length} passed, ${skippedCount} skipped, ${failureCount} failed`);
	}
}

await ChatCompletion.run();
