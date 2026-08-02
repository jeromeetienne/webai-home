import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';
import { BenchmarkCommand, type BenchmarkOptions, type BenchmarkTarget, type CompletionResult } from '../src/commands/benchmark_command.js';

const directTarget: BenchmarkTarget = {
	name: 'LM Studio',
	baseUrl: 'http://direct.test/v1',
	model: 'direct-model',
};

const webaiTarget: BenchmarkTarget = {
	name: 'webai-at-home',
	baseUrl: 'http://webai.test/v1',
	model: 'webai-model',
};

const options: BenchmarkOptions = {
	directTarget,
	webaiTarget,
	target: 'both',
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
	const summary = BenchmarkCommand.summarizeSamples(directTarget, [
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
	const report = await BenchmarkCommand.runBenchmark({ ...options, target: 'direct', runs: 1, warmupRuns: 0 }, async () => completionResult('0123456789', 100, 600));
	const sample = report.summaries[0].samples[0];
	Assert.equal(sample.timeToFirstCharacterMs, 100);
	Assert.equal(sample.timeToLastCharacterMs, 600);
	Assert.equal(sample.outputCharacters, 10);
	Assert.equal(sample.inputCharacters, options.prompt.length);
	// 10 characters over the 500 ms between the Time to First Character and the Time to Last Character is 20 characters per second.
	Assert.equal(sample.outputCharactersPerSecond, 20);
});

Test('floors the streaming duration at 1 ms rather than dividing by zero when the Time to First Character equals the Time to Last Character', async () => {
	const report = await BenchmarkCommand.runBenchmark({ ...options, target: 'direct', runs: 1, warmupRuns: 0 }, async () => completionResult('whole answer', 50, 50));
	const sample = report.summaries[0].samples[0];
	Assert.equal(sample.outputCharactersPerSecond, 'whole answer'.length * 1_000);
});

Test('runs warm-ups and measurements sequentially, direct endpoint before webai-at-home', async () => {
	const calls: string[] = [];
	const report = await BenchmarkCommand.runBenchmark(options, async (target, prompt, timeoutMs) => {
		calls.push(`${target.name}:${prompt}:${timeoutMs}`);
		return target.name === 'LM Studio' ? completionResult('direct answer', 5, 50) : completionResult('WebAI answer', 8, 60);
	});

	Assert.deepEqual(calls, [
		'LM Studio:same prompt:1000',
		'LM Studio:same prompt:1000',
		'LM Studio:same prompt:1000',
		'webai-at-home:same prompt:1000',
		'webai-at-home:same prompt:1000',
		'webai-at-home:same prompt:1000',
	]);
	Assert.equal(report.settings.parallelism, 1);
	Assert.equal(report.summaries[0].outputCharacters.average, 'direct answer'.length);
	Assert.equal(report.summaries[1].outputCharacters.average, 'WebAI answer'.length);
});

Test('writes the same report out as text, markdown, and JSON', async () => {
	const report = await BenchmarkCommand.runBenchmark(options, async (target) => (target.name === 'LM Studio' ? completionResult('direct answer', 5, 50) : completionResult('WebAI answer', 8, 60)));

	const text = BenchmarkCommand.formatReport(report, 'text');
	Assert.match(text, /OpenAI API benchmark \(parallelism: 1\)/);
	Assert.match(text, /Time to First Character:/);
	Assert.match(text, /Time to Last Character:/);
	Assert.match(text, /Output Characters per Second:/);
	Assert.match(text, /webai-at-home Time to First Character overhead:/);
	Assert.match(text, /webai-at-home Time to Last Character overhead:/);

	const markdown = BenchmarkCommand.formatReport(report, 'markdown');
	Assert.match(markdown, /^# OpenAI API benchmark/);
	Assert.match(markdown, /\| Endpoint \| Model \| Time to First Character \| Time to Last Character \| Output Characters per Second \| Input Characters \| Output Characters \|/);
	Assert.match(markdown, /\| LM Studio \|/);
	Assert.match(markdown, /\| webai-at-home \|/);

	const json = BenchmarkCommand.formatReport(report, 'json');
	const parsed = JSON.parse(json);
	Assert.equal(parsed.settings.runs, options.runs);
	Assert.equal(parsed.summaries[0].name, 'LM Studio');
	Assert.equal(typeof parsed.summaries[0].timeToFirstCharacterMs.average, 'number');
});

Test('accepts only the formats it knows about', () => {
	Assert.equal(BenchmarkCommand.isReportFormat('text'), true);
	Assert.equal(BenchmarkCommand.isReportFormat('markdown'), true);
	Assert.equal(BenchmarkCommand.isReportFormat('json'), true);
	Assert.equal(BenchmarkCommand.isReportFormat('yaml'), false);
});

Test('measures only the direct endpoint, and reports no webai-at-home overhead to compare against', async () => {
	const calls: string[] = [];
	const report = await BenchmarkCommand.runBenchmark({ ...options, target: 'direct' }, async (target) => {
		calls.push(target.name);
		return completionResult('direct answer', 5, 50);
	});
	// One warm-up request plus the two measured runs from `options`.
	Assert.deepEqual(calls, ['LM Studio', 'LM Studio', 'LM Studio']);
	Assert.equal(report.summaries.length, 1);
	Assert.equal(report.summaries[0].name, 'LM Studio');
	Assert.equal(report.webaiOverhead, undefined);
});

Test('measures only the webai-at-home endpoint, and reports no webai-at-home overhead to compare against', async () => {
	const calls: string[] = [];
	const report = await BenchmarkCommand.runBenchmark({ ...options, target: 'webai' }, async (target) => {
		calls.push(target.name);
		return completionResult('webai answer', 8, 60);
	});
	Assert.deepEqual(calls, ['webai-at-home', 'webai-at-home', 'webai-at-home']);
	Assert.equal(report.summaries.length, 1);
	Assert.equal(report.summaries[0].name, 'webai-at-home');
	Assert.equal(report.webaiOverhead, undefined);
});

Test('leaves the overhead lines out of every format when only one endpoint was measured', async () => {
	const report = await BenchmarkCommand.runBenchmark({ ...options, target: 'direct' }, async () => completionResult('direct answer', 5, 50));

	Assert.doesNotMatch(BenchmarkCommand.formatReport(report, 'text'), /webai-at-home .* overhead/);
	Assert.doesNotMatch(BenchmarkCommand.formatReport(report, 'markdown'), /webai-at-home .* overhead/);
	Assert.equal(JSON.parse(BenchmarkCommand.formatReport(report, 'json')).webaiOverhead, undefined);
});

Test('accepts only the target selections it knows about', () => {
	Assert.equal(BenchmarkCommand.isTargetSelection('direct'), true);
	Assert.equal(BenchmarkCommand.isTargetSelection('webai'), true);
	Assert.equal(BenchmarkCommand.isTargetSelection('both'), true);
	Assert.equal(BenchmarkCommand.isTargetSelection('neither'), false);
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
		const target: BenchmarkTarget = {
			name: 'LM Studio',
			baseUrl: `http://127.0.0.1:${address.port}`,
			model: 'irrelevant-to-this-test',
		};
		const result = await BenchmarkCommand.requestOpenaiCompletion(target, 'say hello', 5_000);
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
		const target: BenchmarkTarget = {
			name: 'LM Studio',
			baseUrl: `http://127.0.0.1:${address.port}`,
			model: 'irrelevant-to-this-test',
		};
		const result = await BenchmarkCommand.requestOpenaiCompletion(target, 'say hello', 5_000);
		Assert.equal(result.answer, 'whole answer, no streaming');
		Assert.equal(result.timeToFirstCharacterMs, result.timeToLastCharacterMs);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
