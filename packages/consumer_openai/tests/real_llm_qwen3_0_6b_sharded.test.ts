import Assert from 'node:assert/strict';
import NodeTest from 'node:test';
import OpenAI from 'openai';
import { RealTestHelper } from './real_test_helper.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Real llm_qwen3_0_6b_sharded test — the OpenAI-compatible server against a real browser worker cluster
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run test:real:llm_qwen3_0_6b_sharded --workspace @webai/consumer-openai
// Or: npm run test:real:llm_qwen3_0_6b_sharded:headed --workspace @webai/consumer-openai, to watch the browser
// instead of running it headless.
// Add REAL_TEST_SLOW=<milliseconds> to slow every browser operation down, for better observability.
// Add REAL_TEST_DEVTOOLS=true to open Chrome DevTools for the debug page (forces a visible window).
//
// Unlike tests/index.test.ts, this test is not part of the default `npm run test --workspaces`. It builds the
// protocol and consumer CLI packages, starts the central gateway, the worker web page, and this package's own
// OpenAI-compatible server, opens the gateway's `/debug_iframe_llm_qwen3_0_6b_sharded` page in a dedicated
// headless Chrome process to set up the three worker browser tabs the Qwen3-0.6B shard stages need, then
// submits a prompt through the `openai` package and checks the answer mentions the expected capital. It needs
// macOS with Google Chrome installed, the same as README.md asks of the whole repository's real browser tests,
// and a network connection: each worker tab downloads its shard of the roughly 860-megabyte model from Hugging
// Face the first time it runs, which is why setup here is given a much longer timeout than
// tests/real_dev_formula.test.ts.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Setup
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const realTestHelper = new RealTestHelper({
	debugPath: '/debug_iframe_llm_qwen3_0_6b_sharded',
	expectedWorkerCount: 3,
	waitTimeoutMs: 600_000,
	headless: process.env.REAL_TEST_HEADED !== 'true',
	devtools: process.env.REAL_TEST_DEVTOOLS === 'true',
	...(process.env.REAL_TEST_SLOW !== undefined
		? {
			slowMoMs: Number(process.env.REAL_TEST_SLOW),
		}
		: {}),
});

NodeTest.before(async () => {
	await realTestHelper.setup();
}, {
	timeout: 900_000,
});

NodeTest.after(async () => {
	await realTestHelper.teardown();
}, {
	timeout: 30_000,
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

NodeTest.test('answers with the capital of France, through a real browser worker cluster and the OpenAI-compatible server', {
	timeout: 600_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 600_000,
	});
	const completion = await client.chat.completions.create({
		model: 'llm_qwen3_0_6b_sharded',
		messages: [{
			role: 'user',
			content: 'What is the capital of France?',
		}],
	});

	Assert.match(completion.choices[0]?.message.content ?? '', /paris/i);
	// Milestone 3 of issue #150, extended to this task type: a real worker reports its exact
	// prompt and completion token counts and why it stopped, rather than nothing at all.
	Assert.equal(completion.choices[0]?.finish_reason, 'stop');
	Assert.ok(completion.usage !== undefined, 'expected a usage object, and got none');
	Assert.ok((completion.usage?.prompt_tokens ?? 0) > 0, 'expected a positive prompt_tokens count');
	Assert.ok((completion.usage?.completion_tokens ?? 0) > 0, 'expected a positive completion_tokens count');
	Assert.equal(completion.usage?.total_tokens, (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0));
});

NodeTest.test('streams the answer one token at a time, through a real browser worker cluster and the OpenAI-compatible server', {
	timeout: 600_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 600_000,
	});
	const stream = await client.chat.completions.create({
		model: 'llm_qwen3_0_6b_sharded',
		messages: [{
			role: 'user',
			content: 'What is the capital of France?',
		}],
		stream: true,
		stream_options: { include_usage: true },
	});

	let answer = '';
	let pieceCount = 0;
	let usage: OpenAI.CompletionUsage | undefined;
	for await (const chunk of stream) {
		const piece = chunk.choices[0]?.delta.content ?? '';
		if (piece !== '') {
			pieceCount += 1;
			answer += piece;
		}
		if (chunk.usage != null) {
			usage = chunk.usage;
		}
	}

	Assert.ok(pieceCount > 1, `expected the answer to arrive as more than one piece, got ${pieceCount}`);
	Assert.match(answer, /paris/i);
	// Milestone 3 of issue #150, extended to this task type, together with milestone 4's final
	// usage chunk: a real streamed answer carries real usage, asked for with stream_options.
	Assert.ok(usage !== undefined, 'expected a final usage chunk, and got none');
	Assert.ok((usage?.prompt_tokens ?? 0) > 0, 'expected a positive prompt_tokens count');
	Assert.ok((usage?.completion_tokens ?? 0) > 0, 'expected a positive completion_tokens count');
});
