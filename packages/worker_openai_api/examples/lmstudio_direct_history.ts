import OpenAI, { APIError } from 'openai';
import { LmstudioExampleOptions, type ExampleOptionValues } from './lmstudio_example_options.js';
import {
	LmstudioExampleResultsTable,
	type ExampleModelResult,
	type ExampleOutcome,
} from './lmstudio_example_results_table.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LmstudioDirectHistory — checks which LM Studio models carry a conversation across two turns
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:lmstudio_direct_history --workspace @webai/worker-openai-api
//
// This example talks to LM Studio directly through the OpenAI SDK. It does not go through the
// WebAI@Home gateway and it does not go through this package's own worker: nothing here registers
// with a cluster, and no stage is run. What it measures is what the model behind LM Studio can do
// on its own, which is what decides what the worker in `src/` can offer. See
// https://github.com/webai-at-home/webai-at-home/issues/119.
//
// The check is a two-turn conversation. The first request states a fact and asks for nothing else.
// The second request sends the whole conversation so far, including the model's own first answer,
// and asks a question that can only be answered by recalling what the first turn said. A model
// passes when its second answer names both the name and the programming language given in the
// first turn.
//
// It needs LM Studio running, with at least one chat model loaded:
//   lms server start
//
// With no `--model`, it runs against the models the package README records results for, which are
// `llama-3.2-3b-instruct` and `qwen3.5-2b-mlx`, each loaded by LM Studio on demand. Switching to
// other models is one option and nothing else:
//   npm run example:lmstudio_direct_history --workspace @webai/worker-openai-api -- --model qwen3.5-2b-mlx
//   npm run example:lmstudio_direct_history --workspace @webai/worker-openai-api -- --model all
//   npm run example:lmstudio_direct_history --workspace @webai/worker-openai-api -- --model loaded
// `all` is every chat model LM Studio has downloaded, and `loaded` is the ones it currently holds
// in memory, so that loading another model in the LM Studio application is by itself enough to
// test it.

/** The fact the first turn states, and that the second turn asks the model to recall. */
const rememberedName = 'Ada';

/** The other fact the first turn states, and that the second turn asks the model to recall. */
const rememberedLanguage = 'Lisp';

/** The first question, which states both facts and asks for nothing that needs them. */
const firstQuestion = `My name is ${rememberedName} and my favorite programming language is `
	+ `${rememberedLanguage}. Please just say hello back.`;

/** The second question, which can only be answered from the first turn. */
const secondQuestion = 'What is my name, and what is my favorite programming language? Answer in one short sentence.';

/** How long one request to LM Studio may take before it is given up on, in milliseconds. */
const requestTimeoutMs = 600_000;

/**
 * Runs the two-turn conversation against every model asked for, and prints one row per model.
 */
export class LmstudioDirectHistory {
	/**
	 * Runs the example.
	 *
	 * @param options The base URL to talk to and the models to run against.
	 * @returns Nothing.
	 */
	static async run(options: ExampleOptionValues): Promise<void> {
		const client = new OpenAI({
			baseURL: options.baseUrl,
			apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
			maxRetries: 0,
			timeout: requestTimeoutMs,
		});
		const resultsTable = new LmstudioExampleResultsTable(['model', 'answers a second turn', 'recalls the first turn']);

		for (const modelId of options.modelIds) {
			console.log('');
			console.log(`=== ${modelId} ===`);
			const result = await LmstudioDirectHistory._runOneModel(client, modelId);
			resultsTable.addRow(LmstudioExampleResultsTable.modelLabel(modelId, result.answeredByModelId), result.outcomes);
		}

		resultsTable.print();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Holds the two-turn conversation with one model and reports what it did.
	 *
	 * @param client The OpenAI SDK client pointed at LM Studio.
	 * @param modelId The model to ask, named as LM Studio names it.
	 * @returns Which model answered, whether the model answered the second turn at all, and whether
	 * that answer recalled the first turn.
	 */
	private static async _runOneModel(client: OpenAI, modelId: string): Promise<ExampleModelResult> {
		let answeredByModelId = '';
		try {
			console.log(`user: ${firstQuestion}`);
			const firstTurn = await client.chat.completions.create({
				model: modelId,
				messages: [
					{
						role: 'user',
						content: firstQuestion,
					},
				],
			});
			answeredByModelId = firstTurn.model;
			if (answeredByModelId !== modelId) {
				console.warn(`LM Studio answered with ${answeredByModelId}, not with the ${modelId} that was asked for`);
			}
			const firstAnswer = firstTurn.choices[0]?.message.content ?? '';
			console.log(`assistant: ${firstAnswer}`);

			console.log(`user: ${secondQuestion}`);
			const secondTurn = await client.chat.completions.create({
				model: modelId,
				messages: [
					{
						role: 'user',
						content: firstQuestion,
					},
					{
						role: 'assistant',
						content: firstAnswer,
					},
					{
						role: 'user',
						content: secondQuestion,
					},
				],
			});
			const secondAnswer = secondTurn.choices[0]?.message.content ?? '';
			console.log(`assistant: ${secondAnswer}`);

			if (secondAnswer === '') {
				return {
					answeredByModelId,
					outcomes: ['no', 'not reached'],
				};
			}
			const recalledBothFacts = secondAnswer.toLowerCase().includes(rememberedName.toLowerCase())
				&& secondAnswer.toLowerCase().includes(rememberedLanguage.toLowerCase());
			return {
				answeredByModelId,
				outcomes: ['yes', recalledBothFacts ? 'yes' : 'no'],
			};
		} catch (error: unknown) {
			// A refusal is reported in words rather than as a stack trace, because the everyday
			// reason a request fails here is that LM Studio could not load or run that model, which
			// is a result of the experiment and not a fault in this example.
			if (error instanceof APIError) {
				console.error(`LM Studio refused the request with HTTP ${error.status} (${String(error.code)}): ${error.message}`);
				return {
					answeredByModelId,
					outcomes: ['failed', 'not reached'],
				};
			}
			throw error;
		}
	}
}

const options = await LmstudioExampleOptions.read(
	'Checks which LM Studio models carry a conversation across two turns.',
);
LmstudioExampleOptions.announce(options);
await LmstudioDirectHistory.run(options);
