import Assert from 'node:assert/strict';
import NodeTest from 'node:test';
import OpenAI from 'openai';
import type { Page } from 'puppeteer';
import { RealTestHelper } from './real_test_helper.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Real llm_gemma_nano_chrome_full test — the OpenAI-compatible server against a real browser worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run test:real:llm_gemma_nano_chrome_full --workspace @webai/consumer-openai
// Or: npm run test:real:llm_gemma_nano_chrome_full:headed --workspace @webai/consumer-openai, to watch the
// browser instead of running it headless.
// Add REAL_TEST_SLOW=<milliseconds> to slow every browser operation down, for better observability.
// Add REAL_TEST_DEVTOOLS=true to open Chrome DevTools for the debug page (forces a visible window).
//
// Unlike tests/index.test.ts, this test is not part of the default `npm run test --workspaces`. It builds the
// protocol and consumer CLI packages, starts the central gateway, the worker web page, and this package's own
// OpenAI-compatible server, opens the gateway's `/debug_iframe_llm_gemma_nano_chrome_full` page in a dedicated
// Chrome process, then submits a prompt through the `openai` package and checks the answer mentions the
// expected capital. It needs macOS with Google Chrome installed, the same as README.md asks of the whole
// repository's real browser tests, and a Chrome capable of running its own built-in language model.
//
// Chrome only downloads its built-in language model when the person using the page presses a button, so this
// test clicks that button itself once the worker tab offers it (see `clickBuiltInModelDownloadButtonIfOffered`
// below). The model is a Chrome-managed component rather than something this project caches, so on a profile
// that has never downloaded it, this first download can take a long time, hence the long timeouts here.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Setup
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const realTestHelper = new RealTestHelper({
	debugPath: '/debug_iframe_llm_gemma_nano_chrome_full',
	expectedWorkerCount: 1,
	waitTimeoutMs: 600_000,
	headless: process.env.REAL_TEST_HEADED !== 'true',
	devtools: process.env.REAL_TEST_DEVTOOLS === 'true',
	onDebugPageOpen: clickBuiltInModelDownloadButtonIfOffered,
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
//	Test
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
		model: 'llm_gemma_nano_chrome_full',
		messages: [{
			role: 'user',
			content: 'What is the capital of France? Answer in one short sentence.',
		}],
	});

	Assert.match(completion.choices[0]?.message.content ?? '', /paris/i);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Helpers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Clicks the worker page's "Download the browser's built-in language model" button, if the worker tab is
 * currently offering it, so the browser's on-device model download starts without a person present. Chrome
 * only allows a download of its built-in model to start from a genuine user gesture, and does not treat page
 * load or an automated `fetch` as one, so this simulates the button press the page's own UI asks for. If the
 * model is already available the button never appears, and this does nothing.
 *
 * @param page The debug page `RealTestHelper` opened, whose frames include the worker tab's own iframe.
 */
async function clickBuiltInModelDownloadButtonIfOffered(page: Page): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		for (const frame of page.frames()) {
			const button = await frame.$('#built-in-model-download:not(.d-none)').catch(() => null);
			if (button !== null) {
				await button.click();
				return;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	// The browser's built-in language model may already be available, in which case the download
	// button never appears and there is nothing to click.
}
