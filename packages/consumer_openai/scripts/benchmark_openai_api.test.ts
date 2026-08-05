import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';
import { BenchmarkOpenaiApi, type BenchmarkOptions, type BenchmarkTarget, type CompletionResult } from './benchmark_openai_api.js';

const target: BenchmarkTarget = {
	baseUrl: 'http://direct.test/v1',
	model: 'a-model',
	apiKey: 'insecure-benchmark-key',
};

const options: BenchmarkOptions = {
	target,
	prompt: 'same prompt',
	runs: 2,
	warmupRuns: 1,
	timeoutMs: 1_000,
};

/**
 * Builds a `CompletionResult` a mock requester can return, so a test states an answer and its
 * Time to First and Time to Last Character without repeating the object shape every time.
 */
function completionResult(answer: string, timeToFirstCharacterMs: number, timeToLastCharacterMs: number): CompletionResult {
	return {
		answer,
		timeToFirstCharacterMs,
		timeToLastCharacterMs,
	};
}

Test('summarizes every metric from measured samples', () => {
	const summary = BenchmarkOpenaiApi.summarizeSamples(target, [
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
	const report = await BenchmarkOpenaiApi.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('0123456789', 100, 600));
	const sample = report.summary.samples[0];
	Assert.equal(sample.timeToFirstCharacterMs, 100);
	Assert.equal(sample.timeToLastCharacterMs, 600);
	Assert.equal(sample.outputCharacters, 10);
	Assert.equal(sample.inputCharacters, options.prompt.length);
	// 10 characters over the 500 ms between the Time to First Character and the Time to Last Character is 20 characters per second.
	Assert.equal(sample.outputCharactersPerSecond, 20);
});

Test('floors the streaming duration at 1 ms rather than dividing by zero when the Time to First Character equals the Time to Last Character', async () => {
	const report = await BenchmarkOpenaiApi.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('whole answer', 50, 50));
	const sample = report.summary.samples[0];
	Assert.equal(sample.outputCharactersPerSecond, 'whole answer'.length * 1_000);
});

Test('runs the warm-ups and then the measured requests in strict sequence', async () => {
	const calls: string[] = [];
	const report = await BenchmarkOpenaiApi.runBenchmark(options, async (requestedTarget, prompt, timeoutMs) => {
		calls.push(`${requestedTarget.baseUrl}:${prompt}:${timeoutMs}`);
		return completionResult('the answer', 5, 50);
	});

	// One warm-up request plus the two measured runs from `options`.
	Assert.deepEqual(calls, [
		'http://direct.test/v1:same prompt:1000',
		'http://direct.test/v1:same prompt:1000',
		'http://direct.test/v1:same prompt:1000',
	]);
	Assert.equal(report.settings.parallelism, 1);
	Assert.equal(report.summary.outputCharacters.average, 'the answer'.length);
});

Test('writes the same report out as text, markdown, and JSON', async () => {
	const report = await BenchmarkOpenaiApi.runBenchmark(options, async () => completionResult('the answer', 5, 50));

	const text = BenchmarkOpenaiApi.formatReport(report, 'text');
	Assert.match(text, /OpenAI API benchmark \(parallelism: 1\)/);
	Assert.match(text, /Time to First Character:/);
	Assert.match(text, /Time to Last Character:/);
	Assert.match(text, /Output Characters per Second:/);
	Assert.match(text, new RegExp(target.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

	const markdown = BenchmarkOpenaiApi.formatReport(report, 'markdown');
	Assert.match(markdown, /^# OpenAI API benchmark/);
	Assert.match(markdown, /\| Base URL \| Model \| Time to First Character \| Time to Last Character \| Output Characters per Second \| Input Characters \| Output Characters \|/);
	Assert.match(markdown, new RegExp(`\\| ${target.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`));

	const json = BenchmarkOpenaiApi.formatReport(report, 'json');
	const parsed = JSON.parse(json);
	Assert.equal(parsed.settings.runs, options.runs);
	Assert.equal(parsed.summary.baseUrl, target.baseUrl);
	Assert.equal(typeof parsed.summary.timeToFirstCharacterMs.average, 'number');
});

Test('accepts only the formats it knows about', () => {
	Assert.equal(BenchmarkOpenaiApi.isReportFormat('text'), true);
	Assert.equal(BenchmarkOpenaiApi.isReportFormat('markdown'), true);
	Assert.equal(BenchmarkOpenaiApi.isReportFormat('json'), true);
	Assert.equal(BenchmarkOpenaiApi.isReportFormat('yaml'), false);
});

Test('reads Time to First and Time to Last Character from a real server-sent event stream, spaced out over real wall-clock time', async () => {
	const server = Http.createServer((request, response) => {
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
	await new Promise<void>((resolve) => server.listen(0, resolve));
	try {
		const address = server.address();
		if (address === null || typeof address === 'string') {
			throw new Error('The test server did not report a port');
		}
		const liveTarget: BenchmarkTarget = {
			baseUrl: `http://127.0.0.1:${address.port}`,
			model: 'irrelevant-to-this-test',
			apiKey: 'insecure-benchmark-key',
		};
		const result = await BenchmarkOpenaiApi.requestOpenaiCompletion(liveTarget, 'say hello', 5_000);
		Assert.equal(result.answer, 'Hello, world');
		// The two content chunks are spaced 40 ms and then 60 ms apart, so the Time to First
		// Character must land after roughly the first wait and the Time to Last Character after
		// roughly both — proof this measures real elapsed wall-clock time from a real streamed
		// connection, not just the shape of the numbers.
		Assert.ok(result.timeToFirstCharacterMs >= 30, `expected the Time to First Character to reflect the 40 ms wait, got ${result.timeToFirstCharacterMs} ms`);
		Assert.ok(result.timeToLastCharacterMs >= result.timeToFirstCharacterMs + 50, `expected the Time to Last Character to be at least ~60 ms after the Time to First Character, got Time to First Character ${result.timeToFirstCharacterMs} ms and Time to Last Character ${result.timeToLastCharacterMs} ms`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

Test('falls back to reading one JSON body when the server answers stream: true with content-type application/json', async () => {
	const server = Http.createServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer, no streaming' } }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	try {
		const address = server.address();
		if (address === null || typeof address === 'string') {
			throw new Error('The test server did not report a port');
		}
		const liveTarget: BenchmarkTarget = {
			baseUrl: `http://127.0.0.1:${address.port}`,
			model: 'irrelevant-to-this-test',
			apiKey: 'insecure-benchmark-key',
		};
		const result = await BenchmarkOpenaiApi.requestOpenaiCompletion(liveTarget, 'say hello', 5_000);
		Assert.equal(result.answer, 'whole answer, no streaming');
		Assert.equal(result.timeToFirstCharacterMs, result.timeToLastCharacterMs);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
