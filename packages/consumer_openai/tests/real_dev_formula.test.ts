import Assert from 'node:assert/strict';
import NodeTest from 'node:test';
import OpenAI from 'openai';
import { RealTestHelper } from './real_test_helper.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Real dev_formula test — the OpenAI-compatible server against a real browser worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run test:real --workspace @webai/consumer-openai
//
// Unlike tests/index.test.ts, this test is not part of the default `npm run test
// --workspaces`. It builds the protocol and consumer CLI packages, starts the central gateway,
// the worker web page, and this package's own OpenAI-compatible server, opens the gateway's
// `/debug_iframe_dev_formula` page in a dedicated headless Chrome process to set up the two
// worker browser tabs `dev_formula` needs, then submits `5` through the `openai` package and
// checks the answer comes back as `17`. It needs macOS with Google Chrome installed, the same
// as README.md asks of the whole repository's real browser tests.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Setup
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const expectedResult = '17';
const realTestHelper = new RealTestHelper();

NodeTest.before(async () => {
	await realTestHelper.setup();
}, {
	timeout: 120_000,
});

NodeTest.after(async () => {
	await realTestHelper.teardown();
}, {
	timeout: 30_000,
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Test
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

NodeTest.test('answers 17 for input 5, through a real browser worker cluster and the OpenAI-compatible server', {
	timeout: 30_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 30_000,
	});
	const completion = await client.chat.completions.create({
		model: 'dev_formula',
		messages: [{
			role: 'user',
			content: '5',
		}],
	});
	Assert.equal(completion.choices[0]?.message.content, expectedResult);
});
