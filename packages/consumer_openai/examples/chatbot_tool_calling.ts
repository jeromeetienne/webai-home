import ReadlinePromises from 'node:readline/promises';
import Fs from 'node:fs';
import Path from 'node:path';
import OpenAI from 'openai';

import { TextSpinner } from './text_spinner.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	A question-and-answer chatbot on the terminal, able to call a local function
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chatbot_tool_calling --workspace @webai/consumer-openai
//
// This is a TypeScript version of https://github.com/jeromeetienne/openai-chatbot-nodejs,
// pointed at the local gateway instead of the OpenAI servers.
//
// It reads a question from the terminal, sends the whole conversation to the model, and
// prints the answer. When the model asks for the `get_current_weather` function instead of
// answering, the function is run here and its result is sent back as another message, so the
// model can write its answer from it. The weather returned is a fixed made-up value.
//
// It needs the gateway running and one worker browser tab open with a model that can ask for
// a function. Press the ENTER key on an empty line to leave.
//
// Set the environment variable `WEBAI_CHATBOT_DEBUG` to any value to print the messages
// exchanged with the model.

const __dirname = import.meta.dirname;

/** Whether the messages exchanged with the model are printed on the terminal. */
const isDebugEnabled = process.env.WEBAI_CHATBOT_DEBUG !== undefined;

/** Where the questions typed in earlier runs are kept, so they can be recalled with the arrow keys. */
const readlineHistoryPath = Path.join(__dirname, '../logs/chatbot_readline_history.json');

/** The model asked to answer the questions. */
const modelName = process.env.WEBAI_CHATBOT_MODEL ?? 'llm_qwen3_5_0_8b_full';

const textSpinner = new TextSpinner();

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Terminal colors and debug printing
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Wraps text in the escape sequences that terminals read as a color or a weight change.
 */
class TerminalStyle {
	/**
	 * @param text the text to write in a heavier weight
	 * @returns the text surrounded by the bold escape sequences
	 */
	static bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	}

	/**
	 * @param text the text to write in green
	 * @returns the text surrounded by the green escape sequences
	 */
	static green(text: string): string {
		return `\x1b[32m${text}\x1b[39m`;
	}

	/**
	 * @param text the text to write in bright magenta
	 * @returns the text surrounded by the bright magenta escape sequences
	 */
	static magentaBright(text: string): string {
		return `\x1b[95m${text}\x1b[39m`;
	}
}

/**
 * Prints what the chatbot is doing, but only when `WEBAI_CHATBOT_DEBUG` is set.
 */
class ChatbotDebug {
	/**
	 * @param values the values to print, in the same way as `console.log`
	 * @returns nothing
	 */
	static log(...values: unknown[]): void {
		if (isDebugEnabled === false) {
			return;
		}
		console.log('[chatbot]', ...values);
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Init readline
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

let readlineHistory: string[] = [];

const historyFileExists = await Fs.promises
	.access(readlineHistoryPath)
	.then(() => true)
	.catch(() => false);
if (historyFileExists === true) {
	const fileContent = await Fs.promises.readFile(readlineHistoryPath, 'utf-8');
	readlineHistory = JSON.parse(fileContent);
}

const readline = ReadlinePromises.createInterface({
	input: process.stdin,
	output: process.stdout,
	history: readlineHistory,
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Definition of the functions offered to the model
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * A function the model may ask for. It receives the arguments written by the model and
 * returns the result as a string, which is sent back to the model as a message.
 */
type FunctionCallbackFn = (functionArgs: Record<string, unknown>) => Promise<string>;

/**
 * The functions offered to the model, each written as it is run here.
 */
class ChatbotFunctions {
	/**
	 * Returns a made-up weather report, so the example has something to answer with.
	 * @param functionArgs the arguments written by the model, with `location` and an optional `unit`
	 * @returns the weather report, as a JSON text
	 */
	static async getCurrentWeather(functionArgs: Record<string, unknown>): Promise<string> {
		const location = String(functionArgs.location ?? '');
		const unit = String(functionArgs.unit ?? 'celsius');
		const answerJson = {
			location: location,
			temperature: '72',
			unit: unit,
			forecast: ['sunny', 'windy'],
		};
		return JSON.stringify(answerJson);
	}
}

const functionCallbacks: Record<string, FunctionCallbackFn> = {
	get_current_weather: ChatbotFunctions.getCurrentWeather,
};

const functionSchemas: OpenAI.Chat.Completions.ChatCompletionCreateParams.Function[] = [
	{
		name: 'get_current_weather',
		description: 'Get the current weather in a given location',
		parameters: {
			type: 'object',
			properties: {
				location: {
					type: 'string',
					description: 'The city and state, e.g. San Francisco, CA',
				},
				unit: {
					type: 'string',
					enum: ['celsius', 'fahrenheit'],
				},
			},
			required: ['location'],
		},
	},
];

ChatbotDebug.log('functionSchemas:', JSON.stringify(functionSchemas, null, '\t'));

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Define the chat messages
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const startMessage = `
Hello, today i will be your assistant. How can i help you about the weather in various location in the world ? \
(this is just a demo, so the weather is always the same)

To exit, just press ${TerminalStyle.bold('ENTER')} key.
`;

const systemMessage = 'You are a helpful assistant. You are helping a user to get the current weather in a given location.';

const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
	{
		role: 'system',
		content: systemMessage,
	},
];

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Init the OpenAI client
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	main loop
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

console.log(startMessage);

while (true) {
	const latestMessage = chatMessages[chatMessages.length - 1];
	if (latestMessage.role === 'function') {
		// do nothing - the latest message is a function result, so the model answers next
	} else {
		console.log();
		let userInput = await readline.question(TerminalStyle.green('>> '));
		userInput = userInput.trim();

		// an empty line means the user wants to leave
		if (userInput === '') {
			break;
		}

		chatMessages.push({
			role: 'user',
			content: userInput,
		});
	}

	ChatbotDebug.log(`sending chatMessages: ${JSON.stringify(chatMessages, null, '\t')}`);

	textSpinner.start();

	const callResult = await client.chat.completions.create({
		model: modelName,
		messages: chatMessages,
		functions: functionSchemas,
		// tune the temperature to get more or less random results - 0 is deterministic, 1 is random
		temperature: 0.9,
	});

	const responseMessage = callResult.choices[0]?.message;
	ChatbotDebug.log('responseMessage:', responseMessage);

	if (responseMessage !== undefined) {
		chatMessages.push(responseMessage);
	}

	// if the model asked for a function instead of answering, run the function here
	if (responseMessage?.function_call !== undefined && responseMessage.function_call !== null) {
		const functionName = responseMessage.function_call.name ?? '';
		let functionArgs: Record<string, unknown> = {};
		try {
			const argumentsStr = responseMessage.function_call.arguments;
			functionArgs = argumentsStr ? JSON.parse(argumentsStr) : {};
		} catch (error) {
			ChatbotDebug.log(`could not read the arguments of ${functionName}:`, error);
		}
		console.assert(functionName in functionCallbacks, `Unknown function name: ${functionName}`);

		ChatbotDebug.log(`the model asked for the function ${functionName}`);
		ChatbotDebug.log(`function ${functionName} - args: ${JSON.stringify(functionArgs)}`);

		const functionToCall = functionCallbacks[functionName];
		const functionResponse = await functionToCall(functionArgs);

		ChatbotDebug.log(`function ${functionName} - response: ${JSON.stringify(functionResponse)}`);

		chatMessages.push({
			role: 'function',
			name: functionName,
			content: functionResponse,
		});
	}

	textSpinner.stop();

	if (responseMessage?.content !== undefined && responseMessage?.content !== null) {
		ChatbotDebug.log(`the model answered "${responseMessage.content}"`);

		console.log(' ');
		console.log(`${TerminalStyle.magentaBright(responseMessage.content.trim())}`);
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	handle exit
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

console.log('Bye.');

readline.close();

// `history` is kept by readline but is not part of its published type, so it is read through a cast
const writtenHistory = (readline as unknown as { history: string[] }).history;
await Fs.promises.mkdir(Path.dirname(readlineHistoryPath), {
	recursive: true,
});
await Fs.promises.writeFile(readlineHistoryPath, JSON.stringify(writtenHistory, null, '\t'), 'utf-8');
