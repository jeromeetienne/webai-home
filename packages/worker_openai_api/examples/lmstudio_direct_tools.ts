import OpenAI, { APIError } from 'openai';
import { LmstudioExampleOptions, type ExampleOptionValues } from './libs/lmstudio_example_parse_cmdline.js';
import {
	LmstudioExampleResultsTable,
	type ExampleModelResult,
	type ExampleOutcome,
} from './libs/lmstudio_example_display_table.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LmstudioDirectTools — checks which LM Studio models call a tool and use its result
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:lmstudio_direct_tools --workspace @webai/worker-openai-api
//
// This example talks to LM Studio directly through the OpenAI SDK. It does not go through the
// WebAI@Home gateway and it does not go through this package's own worker: nothing here registers
// with a cluster, and no stage is run. What it measures is what the model behind LM Studio can do
// on its own, which is what decides what the worker in `src/` could offer. See
// https://github.com/webai-at-home/webai-at-home/issues/119.
//
// The check is one whole tool round trip, in three steps, each of which a model can fail on its
// own:
//   1. the model is asked a question it cannot answer without the declared tool, and should answer
//      with a tool call rather than with text;
//   2. the tool call and a made-up tool result are added to the conversation, and the whole
//      conversation is sent back, which LM Studio must accept;
//   3. the model should then answer in words, using the number the tool result carried.
//
// A model that fails the first step is still put through the second and the third: the example
// writes the tool call itself and carries on. Emitting a tool call and reading one back out of the
// conversation are two different abilities, and a model that has only the second one can still be
// useful to a caller that decides which tool to run on its own.
//
// It needs LM Studio running, with at least one chat model loaded:
//   lms server start
//
// With no `--model`, it runs against the models the package README records results for, which are
// `llama-3.2-3b-instruct` and `qwen3.5-2b-mlx`, each loaded by LM Studio on demand. Switching to
// other models is one option and nothing else:
//   npm run example:lmstudio_direct_tools --workspace @webai/worker-openai-api -- --model qwen3.5-2b-mlx
//   npm run example:lmstudio_direct_tools --workspace @webai/worker-openai-api -- --model all
//   npm run example:lmstudio_direct_tools --workspace @webai/worker-openai-api -- --model loaded
// `all` is every chat model LM Studio has downloaded, and `loaded` is the ones it currently holds
// in memory, so that loading another model in the LM Studio application is by itself enough to
// test it.

/** The name of the one tool this example declares. */
const toolName = 'get_current_weather';

/** The city the question asks about, and the city the tool result answers about. */
const askedCity = 'Paris';

/**
 * The temperature the made-up tool result carries. It is not a plausible temperature for the
 * season on purpose: an answer that repeats it can only have taken it from the tool result, not
 * from what the model already knew about the city.
 */
const toolResultTemperatureCelsius = 42;

/** The question, which the model cannot answer without calling the tool. */
const question = `What is the current temperature in ${askedCity}? Use the ${toolName} tool, then `
	+ 'answer with the temperature in degrees Celsius.';

/** The one tool this example declares, in the shape the Chat Completions API expects. */
const weatherTool: OpenAI.Chat.Completions.ChatCompletionTool = {
	type: 'function',
	function: {
		name: toolName,
		description: 'Gets the current weather in one city.',
		parameters: {
			type: 'object',
			properties: {
				city: {
					type: 'string',
					description: 'The name of the city, such as Paris.',
				},
			},
			required: ['city'],
		},
	},
};

/**
 * The tool call the example writes itself, and puts in the conversation in the model's place, when
 * the model answered the question in words instead of calling the tool.
 */
const writtenByTheExampleToolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall = {
	id: 'call_written_by_the_example',
	type: 'function',
	function: {
		name: toolName,
		arguments: JSON.stringify({
			city: askedCity,
		}),
	},
};

/** How long one request to LM Studio may take before it is given up on, in milliseconds. */
const requestTimeoutMs = 600_000;

/**
 * Runs the whole tool round trip against every model asked for, and prints one row per model.
 */
export class LmstudioDirectTools {
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
		const resultsTable = new LmstudioExampleResultsTable([
			'model',
			'generates a tool call',
			'accepts the tool result',
			'answers from the tool result',
		]);

		for (const modelId of options.modelIds) {
			console.log('');
			console.log(`=== ${modelId} ===`);
			const result = await LmstudioDirectTools._runOneModel(client, modelId);
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
	 * Runs the whole tool round trip with one model and reports what it did at each step.
	 *
	 * @param client The OpenAI SDK client pointed at LM Studio.
	 * @param modelId The model to ask, named as LM Studio names it.
	 * @returns Which model answered, whether the model answered with a tool call, whether LM Studio
	 * accepted the tool result as part of the conversation, and whether the final answer carried the
	 * number the tool result gave it.
	 */
	private static async _runOneModel(client: OpenAI, modelId: string): Promise<ExampleModelResult> {
		const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
			{
				role: 'user',
				content: question,
			},
		];
		console.log(`user: ${question}`);

		let answeredByModelId = '';
		let toolCallGenerated: ExampleOutcome = 'no';
		let toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
		try {
			const firstTurn = await client.chat.completions.create({
				model: modelId,
				messages,
				tools: [weatherTool],
			});
			answeredByModelId = firstTurn.model;
			if (answeredByModelId !== modelId) {
				console.warn(`LM Studio answered with ${answeredByModelId}, not with the ${modelId} that was asked for`);
			}
			const assistantMessage = firstTurn.choices[0]?.message;
			toolCalls = assistantMessage?.tool_calls ?? [];
			if (toolCalls.length === 0) {
				console.log(`assistant, in words instead of a tool call: ${assistantMessage?.content ?? ''}`);
				console.log('the example now writes the tool call itself, to test the two steps that follow');
				toolCalls = [writtenByTheExampleToolCall];
				messages.push({
					role: 'assistant',
					content: '',
					tool_calls: toolCalls,
				});
			} else {
				toolCallGenerated = 'yes';
				for (const toolCall of toolCalls) {
					console.log(`assistant, as a tool call: ${toolCall.function.name}(${toolCall.function.arguments})`);
				}
				messages.push({
					role: 'assistant',
					content: assistantMessage?.content ?? '',
					tool_calls: toolCalls,
				});
			}
		} catch (error: unknown) {
			return LmstudioDirectTools._resultOfRefusal(error, answeredByModelId, ['failed', 'not reached', 'not reached']);
		}

		// Every tool call is answered, even when the model asked for several, because a
		// conversation that leaves one of them unanswered is not a conversation the API accepts.
		const toolResult = JSON.stringify({
			city: askedCity,
			temperatureCelsius: toolResultTemperatureCelsius,
		});
		for (const toolCall of toolCalls) {
			console.log(`tool: ${toolResult}`);
			messages.push({
				role: 'tool',
				tool_call_id: toolCall.id,
				content: toolResult,
			});
		}

		try {
			const secondTurn = await client.chat.completions.create({
				model: modelId,
				messages,
				tools: [weatherTool],
			});
			const finalAnswer = secondTurn.choices[0]?.message.content ?? '';
			console.log(`assistant: ${finalAnswer}`);
			const usedToolResult = finalAnswer.includes(String(toolResultTemperatureCelsius));
			return {
				answeredByModelId,
				outcomes: [toolCallGenerated, 'yes', usedToolResult ? 'yes' : 'no'],
			};
		} catch (error: unknown) {
			return LmstudioDirectTools._resultOfRefusal(error, answeredByModelId, [toolCallGenerated, 'failed', 'not reached']);
		}
	}

	/**
	 * Turns a refused request into the row it should leave in the table, rather than into a stack
	 * trace, because the everyday reason a request fails here is that the model or LM Studio cannot
	 * do what was asked, which is a result of the experiment and not a fault in this example.
	 *
	 * @param error What the request threw.
	 * @param answeredByModelId The model identifier LM Studio reported in an earlier answer, empty
	 * when it never answered at all.
	 * @param outcomes The row to report when the request was refused by LM Studio.
	 * @returns That row.
	 * @throws The error unchanged when it was not a refusal by LM Studio.
	 */
	private static _resultOfRefusal(
		error: unknown,
		answeredByModelId: string,
		outcomes: ExampleOutcome[],
	): ExampleModelResult {
		if (error instanceof APIError) {
			console.error(`LM Studio refused the request with HTTP ${error.status} (${String(error.code)}): ${error.message}`);
			return {
				answeredByModelId,
				outcomes,
			};
		}
		throw error;
	}
}

const options = await LmstudioExampleOptions.read('Checks which LM Studio models call a tool and use its result.');
LmstudioExampleOptions.announce(options);
await LmstudioDirectTools.run(options);
