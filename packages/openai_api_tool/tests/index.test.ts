// node imports
import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';

// local imports
import { BenchmarkRunner, type BenchmarkOptions } from '../src/benchmark_runner.js';
import { CompletionSender } from '../src/completion_sender.js';
import type { CompletionResult, CompletionTarget } from '../src/completion_types.js';
import { ModelSweeper } from '../src/model_sweeper.js';
import { ReportRenderer } from '../src/report_renderer.js';
import { StatisticsCalculator } from '../src/statistics_calculator.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Helpers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const target: CompletionTarget = {
	baseUrl: 'http://direct.test/v1',
	apiKey: 'insecure-benchmark-key',
	timeoutMs: 1_000,
};

const options: BenchmarkOptions = {
	target,
	modelIds: ['a-model'],
	prompt: 'same prompt',
	runs: 2,
	warmupRuns: 1,
};

/**
 * Builds a `CompletionResult` a mock requester can return, so a test states an answer and its
 * Time to First and Time to Last Character without repeating the object shape every time.
 *
 * @param answer The assistant answer text the mock requester returns.
 * @param timeToFirstCharacterMs When the first character arrived, in milliseconds.
 * @param timeToLastCharacterMs When the final character arrived, in milliseconds.
 * @returns The completion result.
 */
function completionResult(answer: string, timeToFirstCharacterMs: number, timeToLastCharacterMs: number): CompletionResult {
	return {
		answer,
		timeToFirstCharacterMs,
		timeToLastCharacterMs,
	};
}

/**
 * Starts a local HTTP server on a free port, so a test can measure a real streamed connection
 * rather than a stand-in for one.
 *
 * @param handler What the server answers with.
 * @returns The base URL to point a client at, and how to stop the server again.
 */
async function startTestServer(handler: Http.RequestListener): Promise<{ baseUrl: string; stop: () => Promise<void>; }> {
	const server = Http.createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('The test server did not report a port');
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		stop: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StatisticsCalculator
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('calculates the average, median, minimum, and maximum of measured values', () => {
	const statistics = StatisticsCalculator.of([30, 10, 20]);
	Assert.equal(statistics.average, 20);
	Assert.equal(statistics.median, 20);
	Assert.equal(statistics.minimum, 10);
	Assert.equal(statistics.maximum, 30);
});

Test('takes the median of an even number of values as the mean of the two middle ones', () => {
	Assert.equal(StatisticsCalculator.of([10, 20, 30, 50]).median, 25);
});

Test('refuses to calculate statistics when nothing was measured', () => {
	Assert.throws(() => StatisticsCalculator.of([]), /No values were measured/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelSweeper
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const universe = ['dev_formula', 'llm_qwen3_0_6b_sharded', 'llm_llama3_2_3b_full'];

Test('expands all into every model identifier the subcommand knows about', () => {
	Assert.deepEqual(ModelSweeper.resolveModelIds('all', universe, 'reject'), universe);
});

Test('expands a pattern into the identifiers it matches, in the order they are declared', () => {
	Assert.deepEqual(ModelSweeper.resolveModelIds('llm_*', universe, 'reject'), ['llm_qwen3_0_6b_sharded', 'llm_llama3_2_3b_full']);
});

Test('expands a comma-separated list without repeating an identifier matched twice', () => {
	Assert.deepEqual(ModelSweeper.resolveModelIds('llm_*,llm_llama3_2_3b_full', universe, 'reject'), ['llm_qwen3_0_6b_sharded', 'llm_llama3_2_3b_full']);
});

Test('rejects a name outside the list when the subcommand can only reach this cluster', () => {
	Assert.throws(() => ModelSweeper.resolveModelIds('llama-3.2-3b-instruct', universe, 'reject'), /No model matches "llama-3\.2-3b-instruct"/);
});

Test('passes a name outside the list through unchanged when the subcommand can reach any endpoint', () => {
	Assert.deepEqual(ModelSweeper.resolveModelIds('llama-3.2-3b-instruct', universe, 'accept'), ['llama-3.2-3b-instruct']);
});

Test('mixes known identifiers and an outside name in one comma-separated list', () => {
	Assert.deepEqual(
		ModelSweeper.resolveModelIds('dev_formula,llama-3.2-3b-instruct', universe, 'accept'),
		['dev_formula', 'llama-3.2-3b-instruct'],
	);
});

Test('rejects a pattern that matches nothing even when an outside name would be accepted', () => {
	Assert.throws(() => ModelSweeper.resolveModelIds('nothing_*', universe, 'accept'), /No model matches "nothing_\*"/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	BenchmarkRunner
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('summarizes every metric from measured samples', () => {
	const summary = BenchmarkRunner.summarizeSamples(target.baseUrl, 'a-model', [
		{
			run: 1,
			timeToFirstCharacterMs: 10,
			timeToLastCharacterMs: 110,
			outputCharactersPerSecond: 200,
			inputCharacters: 12,
			outputCharacters: 20,
		},
		{
			run: 2,
			timeToFirstCharacterMs: 30,
			timeToLastCharacterMs: 130,
			outputCharactersPerSecond: 400,
			inputCharacters: 12,
			outputCharacters: 40,
		},
	]);
	Assert.equal(summary.timeToFirstCharacterMs.average, 20);
	Assert.equal(summary.timeToFirstCharacterMs.median, 20);
	Assert.equal(summary.timeToFirstCharacterMs.minimum, 10);
	Assert.equal(summary.timeToFirstCharacterMs.maximum, 30);
	Assert.equal(summary.timeToLastCharacterMs.average, 120);
	Assert.equal(summary.outputCharactersPerSecond.average, 300);
	Assert.equal(summary.inputCharacters, 12);
	Assert.equal(summary.outputCharacters.average, 30);
});

Test('computes Output Characters per Second from the Time to First and Time to Last Character of the completion', async () => {
	const report = await BenchmarkRunner.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('0123456789', 100, 600));
	const sample = report.summaries[0].samples[0];
	Assert.equal(sample.timeToFirstCharacterMs, 100);
	Assert.equal(sample.timeToLastCharacterMs, 600);
	Assert.equal(sample.outputCharacters, 10);
	Assert.equal(sample.inputCharacters, options.prompt.length);
	// 10 characters over the 500 ms between the Time to First Character and the Time to Last Character is 20 characters per second.
	Assert.equal(sample.outputCharactersPerSecond, 20);
});

Test('floors the streaming duration at 1 ms rather than dividing by zero when the Time to First Character equals the Time to Last Character', async () => {
	const report = await BenchmarkRunner.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('whole answer', 50, 50));
	Assert.equal(report.summaries[0].samples[0].outputCharactersPerSecond, 'whole answer'.length * 1_000);
});

Test('runs the warm-ups and then the measured requests in strict sequence', async () => {
	const calls: string[] = [];
	const report = await BenchmarkRunner.runBenchmark(options, async (modelId, prompt) => {
		calls.push(`${modelId}:${prompt}`);
		return completionResult('the answer', 5, 50);
	});

	// One warm-up request plus the two measured runs from `options`.
	Assert.deepEqual(calls, [
		'a-model:same prompt',
		'a-model:same prompt',
		'a-model:same prompt',
	]);
	Assert.equal(report.settings.parallelism, 1);
	Assert.equal(report.summaries[0].outputCharacters.average, 'the answer'.length);
});

Test('measures every named model one after the other, finishing one before starting the next', async () => {
	const calls: string[] = [];
	const report = await BenchmarkRunner.runBenchmark(
		{ ...options, modelIds: ['first-model', 'second-model'], runs: 2, warmupRuns: 0 },
		async (modelId) => {
			calls.push(modelId);
			return completionResult('the answer', 5, 50);
		},
	);

	Assert.deepEqual(calls, ['first-model', 'first-model', 'second-model', 'second-model']);
	Assert.equal(report.summaries.length, 2);
	Assert.equal(report.summaries[0].modelId, 'first-model');
	Assert.equal(report.summaries[1].modelId, 'second-model');
});

Test('refuses request counts that are not whole numbers in range', async () => {
	await Assert.rejects(async () => BenchmarkRunner.runBenchmark({ ...options, runs: 0 }, async () => completionResult('a', 1, 2)), /--runs/);
	await Assert.rejects(async () => BenchmarkRunner.runBenchmark({ ...options, warmupRuns: -1 }, async () => completionResult('a', 1, 2)), /--warmup_runs/);
	await Assert.rejects(async () => BenchmarkRunner.runBenchmark({ ...options, modelIds: [] }, async () => completionResult('a', 1, 2)), /--model/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportRenderer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('writes the same benchmark report out as text, markdown, and JSON', async () => {
	const report = await BenchmarkRunner.runBenchmark(options, async () => completionResult('the answer', 5, 50));

	const text = ReportRenderer.formatBenchmarkReport(report, 'text');
	Assert.match(text, /OpenAI API benchmark \(parallelism: 1\)/);
	Assert.match(text, /Time to First Character:/);
	Assert.match(text, /Time to Last Character:/);
	Assert.match(text, /Output Characters per Second:/);
	Assert.match(text, new RegExp(target.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

	const markdown = ReportRenderer.formatBenchmarkReport(report, 'markdown');
	Assert.match(markdown, /^# OpenAI API benchmark/);
	Assert.match(markdown, /\| Base URL \| Model \| Time to First Character \| Time to Last Character \| Output Characters per Second \| Input Characters \| Output Characters \|/);
	Assert.match(markdown, new RegExp(`\\| ${target.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`));

	const json = ReportRenderer.formatBenchmarkReport(report, 'json');
	const parsed = JSON.parse(json);
	Assert.equal(parsed.settings.runs, options.runs);
	Assert.equal(parsed.summaries[0].baseUrl, target.baseUrl);
	Assert.equal(typeof parsed.summaries[0].timeToFirstCharacterMs.average, 'number');
});

Test('gives every measured model its own markdown row', async () => {
	const report = await BenchmarkRunner.runBenchmark(
		{ ...options, modelIds: ['first-model', 'second-model'], runs: 1, warmupRuns: 0 },
		async () => completionResult('the answer', 5, 50),
	);
	const markdown = ReportRenderer.formatBenchmarkReport(report, 'markdown');
	Assert.match(markdown, /\| first-model \|/);
	Assert.match(markdown, /\| second-model \|/);
});

Test('accepts only the report formats it knows about', () => {
	Assert.equal(ReportRenderer.isReportFormat('text'), true);
	Assert.equal(ReportRenderer.isReportFormat('markdown'), true);
	Assert.equal(ReportRenderer.isReportFormat('json'), true);
	Assert.equal(ReportRenderer.isReportFormat('yaml'), false);
});

Test('describes a swept pair as one line, and a skipped pair by why it was skipped', () => {
	const okLine = ReportRenderer.sweepOutcomeLine({
		modelId: 'dev_formula',
		mode: 'nostream',
		status: 'ok',
		timeToFirstCharacterMs: 244.4,
		timeToLastCharacterMs: 244.4,
		characterCount: 2,
		answer: '17',
		failureMessage: undefined,
	});
	Assert.equal(okLine, 'dev_formula (nostream): ok — first character in 244 ms, last character in 244 ms, 2 characters');

	const skippedLine = ReportRenderer.sweepOutcomeLine({
		modelId: 'dev_formula',
		mode: 'streamed',
		status: 'skipped',
		timeToFirstCharacterMs: 0,
		timeToLastCharacterMs: 0,
		characterCount: 0,
		answer: '',
		failureMessage: 'it answers with one number',
	});
	Assert.equal(skippedLine, 'dev_formula (streamed): skipped — it answers with one number');
});

Test('counts passed, skipped, and failed pairs in the sweep summary', () => {
	const lines = ReportRenderer.sweepSummaryLines([
		{ modelId: 'a', mode: 'nostream', status: 'ok', timeToFirstCharacterMs: 1, timeToLastCharacterMs: 2, characterCount: 3, answer: 'abc', failureMessage: undefined },
		{ modelId: 'a', mode: 'streamed', status: 'skipped', timeToFirstCharacterMs: 0, timeToLastCharacterMs: 0, characterCount: 0, answer: '', failureMessage: 'why' },
		{ modelId: 'b', mode: 'nostream', status: 'failed', timeToFirstCharacterMs: 5, timeToLastCharacterMs: 5, characterCount: 0, answer: '', failureMessage: 'no worker' },
	]);
	Assert.equal(lines[lines.length - 1], '1/3 passed, 1 skipped, 1 failed');
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CompletionSender
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('reads Time to First and Time to Last Character from a real server-sent event stream, spaced out over real wall-clock time', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
		});
		response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
		setTimeout(() => {
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`);
			setTimeout(() => {
				response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ', world' } }] })}\n\n`);
				response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
				response.write('data: [DONE]\n\n');
				response.end();
			}, 60);
		}, 40);
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const pieces: string[] = [];
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [
				{
					role: 'user',
					content: 'say hello',
				},
			],
			mode: 'streamed',
			writePiece: (piece) => pieces.push(piece),
		});
		Assert.equal(result.answer, 'Hello, world');
		Assert.deepEqual(pieces, ['Hello', ', world']);
		// The two content chunks are spaced 40 ms and then 60 ms apart, so the Time to First
		// Character must land after roughly the first wait and the Time to Last Character after
		// roughly both — proof this measures real elapsed wall-clock time from a real streamed
		// connection, not just the shape of the numbers.
		Assert.ok(result.timeToFirstCharacterMs >= 30, `expected the Time to First Character to reflect the 40 ms wait, got ${result.timeToFirstCharacterMs} ms`);
		Assert.ok(
			result.timeToLastCharacterMs >= result.timeToFirstCharacterMs + 50,
			`expected the Time to Last Character to be at least ~60 ms after the Time to First Character, got Time to First Character ${result.timeToFirstCharacterMs} ms and Time to Last Character ${result.timeToLastCharacterMs} ms`,
		);
	} finally {
		await server.stop();
	}
});

Test('falls back to one whole request when the endpoint ignores the streaming request and answers with one JSON body', async () => {
	// The `openai` npm package reads such a body as a stream carrying no pieces at all, so
	// without the fallback this endpoint would look like one that answered with nothing.
	const requestedStreams: unknown[] = [];
	const server = await startTestServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on('end', () => {
			requestedStreams.push(JSON.parse(body).stream);
			response.writeHead(200, {
				'Content-Type': 'application/json',
			});
			response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer, no streaming' } }] }));
		});
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [
				{
					role: 'user',
					content: 'say hello',
				},
			],
			mode: 'streamed',
		});
		Assert.equal(result.answer, 'whole answer, no streaming');
		Assert.equal(result.timeToFirstCharacterMs, result.timeToLastCharacterMs);
		Assert.deepEqual(requestedStreams, [true, undefined]);
	} finally {
		await server.stop();
	}
});

Test('reports an endpoint that answered with no text at all as a failure', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		await Assert.rejects(
			async () => CompletionSender.send({
				client,
				modelId: 'irrelevant-to-this-test',
				messages: [
					{
						role: 'user',
						content: 'say hello',
					},
				],
				mode: 'nostream',
			}),
			/no answer text/,
		);
	} finally {
		await server.stop();
	}
});

Test('reports a refusal from the endpoint in words rather than as a stack trace', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(503, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ error: { message: 'no worker is offering this work', code: 'no_worker' } }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		try {
			await CompletionSender.send({
				client,
				modelId: 'irrelevant-to-this-test',
				messages: [
					{
						role: 'user',
						content: 'say hello',
					},
				],
				mode: 'nostream',
			});
			Assert.fail('the request should have been refused');
		} catch (error: unknown) {
			const message = CompletionSender.describeFailure(error);
			Assert.match(message, /^HTTP 503 \(no_worker\)/);
			Assert.match(message, /no worker is offering this work/);
		}
	} finally {
		await server.stop();
	}
});
