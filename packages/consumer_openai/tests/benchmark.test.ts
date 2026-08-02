import Assert from 'node:assert/strict';
import Test from 'node:test';
import { Benchmark, type BenchmarkOptions, type BenchmarkTarget } from '../src/benchmark.js';

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
	prompt: 'same prompt',
	runs: 2,
	warmupRuns: 1,
	timeoutMs: 1_000,
};

Test('summarizes elapsed times and response sizes', () => {
	const summary = Benchmark.summarizeSamples(directTarget, [
		{
			run: 1,
			elapsedMs: 10,
			responseCharacters: 20,
		},
		{
			run: 2,
			elapsedMs: 30,
			responseCharacters: 40,
		},
	]);
	Assert.equal(summary.averageElapsedMs, 20);
	Assert.equal(summary.medianElapsedMs, 20);
	Assert.equal(summary.minimumElapsedMs, 10);
	Assert.equal(summary.maximumElapsedMs, 30);
	Assert.equal(summary.averageResponseCharacters, 30);
	Assert.equal(summary.responseCharactersPerSecond, 1_500);
});

Test('runs warm-ups and measurements sequentially, direct endpoint before webai-at-home', async () => {
	const calls: string[] = [];
	const report = await Benchmark.runBenchmark(options, async (target, prompt, timeoutMs) => {
		calls.push(`${target.name}:${prompt}:${timeoutMs}`);
		return target.name === 'LM Studio' ? 'direct answer' : 'WebAI answer';
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
	Assert.equal(report.summaries[0].averageResponseCharacters, 'direct answer'.length);
	Assert.equal(report.summaries[1].averageResponseCharacters, 'WebAI answer'.length);
});

Test('writes the same report out as text, markdown, and JSON', async () => {
	const report = await Benchmark.runBenchmark(options, async (target) => (target.name === 'LM Studio' ? 'direct answer' : 'WebAI answer'));

	const text = Benchmark.formatReport(report, 'text');
	Assert.match(text, /OpenAI API benchmark \(parallelism: 1\)/);
	Assert.match(text, /webai-at-home overhead:/);

	const markdown = Benchmark.formatReport(report, 'markdown');
	Assert.match(markdown, /^# OpenAI API benchmark/);
	Assert.match(markdown, /\| Endpoint \| Model \| Average \| Median \| Range \| Answer length \| Output \|/);
	Assert.match(markdown, /\| LM Studio \|/);
	Assert.match(markdown, /\| webai-at-home \|/);

	const json = Benchmark.formatReport(report, 'json');
	const parsed = JSON.parse(json);
	Assert.equal(parsed.settings.runs, options.runs);
	Assert.equal(parsed.summaries[0].name, 'LM Studio');
});

Test('accepts only the formats it knows about', () => {
	Assert.equal(Benchmark.isReportFormat('text'), true);
	Assert.equal(Benchmark.isReportFormat('markdown'), true);
	Assert.equal(Benchmark.isReportFormat('json'), true);
	Assert.equal(Benchmark.isReportFormat('yaml'), false);
});
