import OpenAI, { APIError } from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Shows what happens when a request asks for the answer to be streamed
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chat_completion_streaming_refused --workspace @webai/consumer-openai
//
// This server does not stream an answer yet, and says so plainly rather than pretending to.
// A request that asks for streaming is refused with HTTP 400, which the openai package raises
// as a bad request error naming the `stream` field.
//
// The reason is in the cluster, not in this server. The central gateway sends a consumer a slim
// revision of a task as the task advances, and that revision deliberately carries no partial
// output text, because sending the whole task on every revision would make the bytes on the
// connection grow with the square of the number of tokens generated. Streaming therefore needs
// the gateway to report the text generated so far, which is follow-up work tracked with
// https://github.com/webai-at-home/webai-at-home/issues/34.
//
// This example reaches this server only, so it answers even when no gateway is running.

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
});

try {
	const stream = await client.chat.completions.create({
		model: 'dev_formula',
		messages: [{ role: 'user', content: '5' }],
		stream: true,
	});
	for await (const chunk of stream) console.log(chunk);
	console.log('The request was streamed, so this server now supports streaming.');
} catch (error: unknown) {
	if (error instanceof APIError) {
		console.log(`The request was refused with HTTP ${error.status}, as expected.`);
		console.log(`field at fault: ${String(error.param)}`);
		console.log(`reason: ${error.message}`);
	} else {
		throw error;
	}
}
