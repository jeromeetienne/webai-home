#!/usr/bin/env node
// npm imports
import { Command } from 'commander';

const __filename = import.meta.filename;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Benchmark — compares LM Studio latency directly with the same model behind webai-at-home
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One endpoint and model combination measured by the benchmark. */
export type BenchmarkTarget = {
	/** The label printed in the report. */
	readonly name: 'LM Studio' | 'webai-at-home';
	/** The base URL of the OpenAI-compatible API, without `/chat/completions`. */
	readonly baseUrl: string;
	/** The model identifier accepted by this endpoint. */
	readonly model: string;
	/** An optional bearer token for this endpoint. */
	readonly apiKey?: string;
};

/** The options that control one benchmark run. */
export type BenchmarkOptions = {
	/** The direct LM Studio endpoint. */
	readonly directTarget: BenchmarkTarget;
	/** The webai-at-home OpenAI-compatible endpoint. */
	readonly webaiTarget: BenchmarkTarget;
	/** The one prompt sent to both endpoints. */
	readonly prompt: string;
	/** The number of measured requests per endpoint. */
	readonly runs: number;
	/** The number of unreported warm-up requests per endpoint. */
	readonly warmupRuns: number;
	/** The maximum time allowed for one request. */
	readonly timeoutMs: number;
};

/** The result of one measured request. */
export type BenchmarkSample = {
	/** The one-based measured request number. */
	readonly run: number;
	/** Wall-clock time from request start until the complete response arrived. */
	readonly elapsedMs: number;
	/** The number of characters in the returned assistant answer. */
	readonly responseCharacters: number;
};

/** The aggregate measurements for one endpoint. */
export type BenchmarkSummary = {
	/** The label of the endpoint measured. */
	readonly name: BenchmarkTarget['name'];
	/** The model identifier used by the endpoint. */
	readonly model: string;
	/** The measured samples, in request order. */
	readonly samples: readonly BenchmarkSample[];
	/** The total elapsed time of the measured requests. */
	readonly totalElapsedMs: number;
	/** The arithmetic mean of the measured elapsed times. */
	readonly averageElapsedMs: number;
	/** The middle measured elapsed time, or the mean of the two middle values. */
	readonly medianElapsedMs: number;
	/** The shortest measured elapsed time. */
	readonly minimumElapsedMs: number;
	/** The longest measured elapsed time. */
	readonly maximumElapsedMs: number;
	/** The arithmetic mean of the returned answer lengths. */
	readonly averageResponseCharacters: number;
	/** The returned answer characters per second, based on total elapsed time. */
	readonly responseCharactersPerSecond: number;
};

/** The full benchmark report, including the direct-versus-WebAI comparison. */
export type BenchmarkReport = {
	/** The benchmark settings that affect comparability. */
	readonly settings: {
		/** The one prompt sent to both endpoints. */
		readonly prompt: string;
		/** The number of measured requests per endpoint. */
		readonly runs: number;
		/** The number of unreported warm-up requests per endpoint. */
		readonly warmupRuns: number;
		/** The number of requests in flight at any moment, always one. */
		readonly parallelism: 1;
	};
	/** The direct LM Studio summary followed by the webai-at-home summary. */
	readonly summaries: readonly [BenchmarkSummary, BenchmarkSummary];
	/** The webai-at-home elapsed-time difference from the direct baseline. */
	readonly webaiOverhead: {
		/** The added average elapsed time per request, in milliseconds. */
		readonly averageElapsedMs: number;
		/** The added average elapsed time as a percentage of the direct average. */
		readonly percentOfDirectAverage: number;
	};
};

/** The completion request used by the runner, replaceable for deterministic tests. */
export type CompletionRequester = (target: BenchmarkTarget, prompt: string, timeoutMs: number) => Promise<string>;

/** The shape of the part of an OpenAI Chat Completions response this benchmark reads. */
type ChatCompletionResponse = {
	/** The answers returned by the endpoint, of which only the first one is read. */
	choices?: {
		/** The assistant message of one answer. */
		message?: {
			/** The assistant answer text, of an unknown type until it has been checked. */
			content?: unknown;
		};
	}[];
};

/** The command-line values before conversion to numbers. */
type RawOptions = {
	/** The LM Studio OpenAI-compatible API base URL. */
	directBaseUrl: string;
	/** The model identifier accepted by LM Studio. */
	directModel: string;
	/** The webai-at-home OpenAI-compatible API base URL. */
	webaiBaseUrl: string;
	/** The model identifier accepted by webai-at-home. */
	webaiModel: string;
	/** The one prompt sent to both endpoints. */
	prompt: string;
	/** The number of measured requests per endpoint, still as text. */
	runs: string;
	/** The number of unreported warm-up requests per endpoint, still as text. */
	warmupRuns: string;
	/** The maximum time allowed for one request, still as text. */
	timeoutMs: string;
	/** The optional bearer token sent to both endpoints. */
	apiKey?: string;
	/** Whether the complete report should be printed as JSON. */
	json?: boolean;
};

/** The parsed command line, split into the benchmark options and the output format. */
type ParsedCommandLine = {
	/** The options that control one benchmark run. */
	options: BenchmarkOptions;
	/** Whether the complete report should be printed as JSON. */
	isJson: boolean;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Benchmark
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Measures and compares the latency of two OpenAI-compatible endpoints serving the same model. */
export class Benchmark {
	/**
	 * Sends one non-streaming Chat Completions request to an OpenAI-compatible endpoint.
	 *
	 * @param target The endpoint and model to send the request to.
	 * @param prompt The single user message sent to the endpoint.
	 * @param timeoutMs The maximum time allowed for the request.
	 * @returns The assistant answer text of the first returned answer.
	 */
	static async requestOpenaiCompletion(target: BenchmarkTarget, prompt: string, timeoutMs: number): Promise<string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (target.apiKey !== undefined) {
			headers['Authorization'] = `Bearer ${target.apiKey}`;
		}
		const requestUrl = `${Benchmark._withoutTrailingSlash(target.baseUrl)}/chat/completions`;
		const response = await fetch(requestUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: target.model,
				messages: [
					{
						role: 'user',
						content: prompt,
					},
				],
				stream: false,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		}).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`${target.name} could not be reached: ${reason}`);
		});
		if (response.ok === false) {
			throw await Benchmark._responseFailure(response, target);
		}
		const body = await response.json() as ChatCompletionResponse;
		const answer = body.choices?.[0]?.message?.content;
		if (typeof answer !== 'string') {
			throw new Error(`${target.name} returned no assistant answer in its Chat Completions response`);
		}
		return answer;
	}

	/**
	 * Calculates the total, average, median, shortest and longest elapsed times from measured samples.
	 *
	 * @param target The endpoint the samples were measured against.
	 * @param samples The measured samples, in request order.
	 * @returns The aggregate measurements for the endpoint.
	 */
	static summarizeSamples(target: BenchmarkTarget, samples: readonly BenchmarkSample[]): BenchmarkSummary {
		if (samples.length === 0) {
			throw new Error(`The benchmark produced no samples for ${target.name}`);
		}
		const elapsedTimes = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
		const totalElapsedMs = samples.reduce((total, sample) => total + sample.elapsedMs, 0);
		const totalResponseCharacters = samples.reduce((total, sample) => total + sample.responseCharacters, 0);
		const middle = Math.floor(elapsedTimes.length / 2);
		const medianElapsedMs = elapsedTimes.length % 2 === 1
			? elapsedTimes[middle]
			: (elapsedTimes[middle - 1] + elapsedTimes[middle]) / 2;
		return {
			name: target.name,
			model: target.model,
			samples,
			totalElapsedMs,
			averageElapsedMs: totalElapsedMs / samples.length,
			medianElapsedMs,
			minimumElapsedMs: elapsedTimes[0],
			maximumElapsedMs: elapsedTimes[elapsedTimes.length - 1],
			averageResponseCharacters: totalResponseCharacters / samples.length,
			responseCharactersPerSecond: totalResponseCharacters / (totalElapsedMs / 1_000),
		};
	}

	/**
	 * Runs LM Studio first and webai-at-home second, with no concurrent requests.
	 *
	 * @param options The options that control this benchmark run.
	 * @param requester The completion request used for every measured and warm-up request.
	 * @returns The full benchmark report, including the direct-versus-WebAI comparison.
	 */
	static async runBenchmark(
		options: BenchmarkOptions,
		requester: CompletionRequester = Benchmark.requestOpenaiCompletion,
	): Promise<BenchmarkReport> {
		if (options.runs < 1 || Number.isInteger(options.runs) === false) {
			throw new Error('--runs must be a positive integer');
		}
		if (options.warmupRuns < 0 || Number.isInteger(options.warmupRuns) === false) {
			throw new Error('--warmup-runs must be a non-negative integer');
		}
		if (options.timeoutMs < 1 || Number.isInteger(options.timeoutMs) === false) {
			throw new Error('--timeout-ms must be a positive integer');
		}
		// These awaits are deliberately sequential. Parallel requests would measure queueing and
		// shared-model contention, which is outside this first direct-versus-WebAI comparison.
		const directSummary = await Benchmark._benchmarkTarget(options.directTarget, options, requester);
		const webaiSummary = await Benchmark._benchmarkTarget(options.webaiTarget, options, requester);
		const averageElapsedMs = webaiSummary.averageElapsedMs - directSummary.averageElapsedMs;
		const percentOfDirectAverage = directSummary.averageElapsedMs === 0
			? 0
			: (averageElapsedMs / directSummary.averageElapsedMs) * 100;
		return {
			settings: {
				prompt: options.prompt,
				runs: options.runs,
				warmupRuns: options.warmupRuns,
				parallelism: 1,
			},
			summaries: [directSummary, webaiSummary],
			webaiOverhead: {
				averageElapsedMs,
				percentOfDirectAverage,
			},
		};
	}

	/**
	 * Runs the command-line benchmark and prints its report.
	 *
	 * @param args The command-line arguments, without the runtime and script names.
	 * @returns Nothing, once the report has been printed.
	 */
	static async runCli(args: string[] = process.argv.slice(2)): Promise<void> {
		const { options, isJson } = Benchmark._parseOptions(args);
		const report = await Benchmark.runBenchmark(options);
		if (isJson === true) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			Benchmark._printHumanReport(report);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Removes trailing slashes before appending an OpenAI API route.
	 *
	 * @param baseUrl The base URL of an OpenAI-compatible API.
	 * @returns The same base URL without any trailing slash.
	 */
	private static _withoutTrailingSlash(baseUrl: string): string {
		return baseUrl.replace(/\/+$/, '');
	}

	/**
	 * Formats a network failure without exposing an unreadable response body in the report.
	 *
	 * @param response The unsuccessful response returned by the endpoint.
	 * @param target The endpoint the request was sent to.
	 * @returns The error describing the failure, ready to be thrown.
	 */
	private static async _responseFailure(response: Response, target: BenchmarkTarget): Promise<Error> {
		const body = await response.text().catch(() => '');
		const detail = body.trim() === '' ? '' : `: ${body.trim().slice(0, 500)}`;
		return new Error(`${target.name} answered with HTTP ${response.status}${detail}`);
	}

	/**
	 * Runs one target's warm-ups and measured requests in strict sequence.
	 *
	 * @param target The endpoint and model to measure.
	 * @param options The prompt, request counts and timeout of this benchmark run.
	 * @param requester The completion request used for every measured and warm-up request.
	 * @returns The aggregate measurements for the endpoint.
	 */
	private static async _benchmarkTarget(
		target: BenchmarkTarget,
		options: Pick<BenchmarkOptions, 'prompt' | 'runs' | 'warmupRuns' | 'timeoutMs'>,
		requester: CompletionRequester,
	): Promise<BenchmarkSummary> {
		for (let warmup = 0; warmup < options.warmupRuns; warmup += 1) {
			await requester(target, options.prompt, options.timeoutMs);
		}
		const samples: BenchmarkSample[] = [];
		for (let run = 1; run <= options.runs; run += 1) {
			const startedAt = performance.now();
			const answer = await requester(target, options.prompt, options.timeoutMs);
			const elapsedMs = performance.now() - startedAt;
			samples.push({
				run,
				elapsedMs,
				responseCharacters: answer.length,
			});
		}
		return Benchmark.summarizeSamples(target, samples);
	}

	/**
	 * Parses the benchmark command line.
	 *
	 * @param args The command-line arguments, without the runtime and script names.
	 * @returns The benchmark options and whether the report should be printed as JSON.
	 */
	private static _parseOptions(args: string[]): ParsedCommandLine {
		const defaultPrompt = 'What is the capital of France? Answer in one short sentence.';
		const program = new Command('benchmark')
			.description('Compare direct LM Studio latency with the same model behind webai-at-home')
			.option('--direct-base-url <url>', 'LM Studio OpenAI-compatible API base URL', 'http://localhost:1234/v1')
			.option('--direct-model <model>', 'model identifier accepted by LM Studio', 'llama-3.2-3b-instruct')
			.option('--webai-base-url <url>', 'webai-at-home OpenAI-compatible API base URL', 'http://localhost:8788/v1')
			.option('--webai-model <model>', 'model identifier accepted by webai-at-home', 'llm_llama3_2_3b_full')
			.option('--prompt <text>', 'one prompt sent to both endpoints', defaultPrompt)
			.option('--runs <number>', 'measured requests per endpoint', '10')
			.option('--warmup-runs <number>', 'unreported warm-up requests per endpoint', '1')
			.option('--timeout-ms <number>', 'maximum time for one request', '600000')
			.option('--api-key <key>', 'optional bearer token sent to both endpoints')
			.option('--json', 'print the complete report as JSON');
		const raw = program.parse(args, { from: 'user' }).opts<RawOptions>();
		return {
			options: {
				directTarget: Benchmark._buildTarget('LM Studio', raw.directBaseUrl, raw.directModel, raw.apiKey),
				webaiTarget: Benchmark._buildTarget('webai-at-home', raw.webaiBaseUrl, raw.webaiModel, raw.apiKey),
				prompt: raw.prompt,
				runs: Benchmark._positiveInteger(raw.runs, '--runs'),
				warmupRuns: Benchmark._positiveInteger(raw.warmupRuns, '--warmup-runs', true),
				timeoutMs: Benchmark._positiveInteger(raw.timeoutMs, '--timeout-ms'),
			},
			isJson: raw.json === true,
		};
	}

	/**
	 * Builds one measured endpoint, leaving the bearer token out when the command line did not set one.
	 *
	 * @param name The label printed in the report.
	 * @param baseUrl The base URL of the OpenAI-compatible API.
	 * @param model The model identifier accepted by the endpoint.
	 * @param apiKey The bearer token for the endpoint, or `undefined` when no token was given.
	 * @returns The endpoint and model combination to measure.
	 */
	private static _buildTarget(
		name: BenchmarkTarget['name'],
		baseUrl: string,
		model: string,
		apiKey: string | undefined,
	): BenchmarkTarget {
		if (apiKey === undefined) {
			return {
				name,
				baseUrl,
				model,
			};
		}
		return {
			name,
			baseUrl,
			model,
			apiKey,
		};
	}

	/**
	 * Converts one command-line numeric option and reports a useful option name on failure.
	 *
	 * @param value The command-line value, still as text.
	 * @param optionName The option name printed when the value is rejected.
	 * @param allowZero Whether zero is an acceptable value.
	 * @returns The converted whole number.
	 */
	private static _positiveInteger(value: string, optionName: string, allowZero = false): number {
		const parsed = Number(value);
		const isValid = Number.isInteger(parsed) && (allowZero === true ? parsed >= 0 : parsed > 0);
		if (isValid === false) {
			const expected = allowZero === true ? 'a non-negative' : 'a positive';
			throw new Error(`${optionName} must be ${expected} integer`);
		}
		return parsed;
	}

	/**
	 * Rounds a report number for readable human output while retaining full values in JSON mode.
	 *
	 * @param value The report number to round.
	 * @returns The number as text with two decimal places.
	 */
	private static _rounded(value: number): string {
		return value.toFixed(2);
	}

	/**
	 * Prints the report in a compact human-readable form.
	 *
	 * @param report The full benchmark report to print.
	 * @returns Nothing.
	 */
	private static _printHumanReport(report: BenchmarkReport): void {
		console.log(`OpenAI API benchmark (parallelism: ${report.settings.parallelism})`);
		console.log(
			`Measured requests per endpoint: ${report.settings.runs}; ` +
				`warm-up requests: ${report.settings.warmupRuns}`,
		);
		for (const summary of report.summaries) {
			const range = `${Benchmark._rounded(summary.minimumElapsedMs)}–${Benchmark._rounded(summary.maximumElapsedMs)}`;
			console.log(`${summary.name} (${summary.model})`);
			console.log(`  average: ${Benchmark._rounded(summary.averageElapsedMs)} ms`);
			console.log(`  median:  ${Benchmark._rounded(summary.medianElapsedMs)} ms`);
			console.log(`  range:   ${range} ms`);
			console.log(`  answer:  ${Benchmark._rounded(summary.averageResponseCharacters)} characters on average`);
			console.log(`  output:  ${Benchmark._rounded(summary.responseCharactersPerSecond)} characters/second`);
		}
		console.log(
			`webai-at-home overhead: ${Benchmark._rounded(report.webaiOverhead.averageElapsedMs)} ms per request ` +
				`(${Benchmark._rounded(report.webaiOverhead.percentOfDirectAverage)}% of the direct average)`,
		);
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

if (process.argv[1] !== undefined && __filename === process.argv[1]) {
	await Benchmark.runCli();
}
