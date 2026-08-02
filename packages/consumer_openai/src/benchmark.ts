// npm imports
import { Command } from 'commander';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Benchmark — compares LM Studio latency directly with the same model behind webai-at-home
//
//	Every request asks for its answer in pieces (`stream: true`), so the benchmark can measure
//	Time to First Character and Time to Last Character separately, the way a person waiting on
//	the answer would experience the difference between the two. An endpoint that ignores the
//	streaming request and answers in one piece still works: its first and last character then
//	arrive at the same moment.
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

/** Which of the two endpoints a benchmark run measures. */
export type BenchmarkTargetSelection = 'direct' | 'webai' | 'both';

/** Every target selection `benchmark` accepts, in the order the help text lists them. */
export const benchmarkTargetSelections: BenchmarkTargetSelection[] = ['direct', 'webai', 'both'];

/** The options that control one benchmark run. */
export type BenchmarkOptions = {
	/** The direct LM Studio endpoint. */
	readonly directTarget: BenchmarkTarget;
	/** The webai-at-home OpenAI-compatible endpoint. */
	readonly webaiTarget: BenchmarkTarget;
	/** Which of the two endpoints to measure. */
	readonly target: BenchmarkTargetSelection;
	/** The one prompt sent to both endpoints. */
	readonly prompt: string;
	/** The number of measured requests per endpoint. */
	readonly runs: number;
	/** The number of unreported warm-up requests per endpoint. */
	readonly warmupRuns: number;
	/** The maximum time allowed for one request. */
	readonly timeoutMs: number;
};

/** One statistic computed over a set of measured samples. */
export type MetricStatistics = {
	/** The arithmetic mean of the measured values. */
	readonly average: number;
	/** The middle measured value, or the mean of the two middle values. */
	readonly median: number;
	/** The smallest measured value. */
	readonly minimum: number;
	/** The largest measured value. */
	readonly maximum: number;
};

/**
 * The result of one measured request.
 *
 * These five figures are all directly observable from the client side: none of them needs
 * knowledge of the model or its tokenizer, which is what keeps them comparable across
 * different providers and APIs.
 */
export type BenchmarkSample = {
	/** The one-based measured request number. */
	readonly run: number;
	/**
	 * Time to First Character (TTFC): elapsed time, in milliseconds, from the request being
	 * sent until the first streamed character arrived. Measures perceived responsiveness.
	 */
	readonly timeToFirstCharacterMs: number;
	/**
	 * Time to Last Character (TTLC): elapsed time, in milliseconds, from the request being
	 * sent until the final character arrived. Measures end-to-end request latency.
	 */
	readonly timeToLastCharacterMs: number;
	/**
	 * Output Characters per Second (OCPS): the speed at which the endpoint streamed the answer
	 * after its first character, computed as `outputCharacters / ((TTLC − TTFC) in seconds)`.
	 */
	readonly outputCharactersPerSecond: number;
	/** Input Characters: the number of characters sent in the request prompt. */
	readonly inputCharacters: number;
	/** Output Characters: the number of characters generated in the response. */
	readonly outputCharacters: number;
};

/** The aggregate measurements for one endpoint. */
export type BenchmarkSummary = {
	/** The label of the endpoint measured. */
	readonly name: BenchmarkTarget['name'];
	/** The model identifier used by the endpoint. */
	readonly model: string;
	/** The measured samples, in request order. */
	readonly samples: readonly BenchmarkSample[];
	/** Time to First Character (TTFC), across the measured samples. */
	readonly timeToFirstCharacterMs: MetricStatistics;
	/** Time to Last Character (TTLC), across the measured samples. */
	readonly timeToLastCharacterMs: MetricStatistics;
	/** Output Characters per Second (OCPS), across the measured samples. */
	readonly outputCharactersPerSecond: MetricStatistics;
	/** Input Characters sent in the prompt, the same for every sample since one prompt is sent to both endpoints. */
	readonly inputCharacters: number;
	/** Output Characters generated in the response, across the measured samples. */
	readonly outputCharacters: MetricStatistics;
};

/** How webai-at-home's average timing differs from the direct baseline, for one metric. */
type OverheadComparison = {
	/** The added average time per request, in milliseconds. */
	readonly averageMs: number;
	/** The added average time as a percentage of the direct average. */
	readonly percentOfDirectAverage: number;
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
	/** The direct LM Studio summary, the webai-at-home summary, or both, in that order. */
	readonly summaries: readonly BenchmarkSummary[];
	/**
	 * How webai-at-home's Time to First Character and Time to Last Character differ from the
	 * direct baseline, present only when both endpoints were measured and there is a baseline
	 * to compare against.
	 */
	readonly webaiOverhead?: {
		/** How Time to First Character (TTFC) differs. */
		readonly timeToFirstCharacterMs: OverheadComparison;
		/** How Time to Last Character (TTLC) differs. */
		readonly timeToLastCharacterMs: OverheadComparison;
	};
};

/** The ways `benchmark` can write its report out. */
export type BenchmarkReportFormat = 'text' | 'markdown' | 'json';

/** Every format `benchmark` accepts, in the order the help text lists them. */
export const benchmarkReportFormats: BenchmarkReportFormat[] = ['text', 'markdown', 'json'];

/** What one completion request produced: the answer text and when its characters arrived. */
export type CompletionResult = {
	/** The complete assistant answer, concatenated from every streamed piece. */
	readonly answer: string;
	/**
	 * Elapsed time, in milliseconds, from the request being sent until the first character
	 * arrived. Equal to `timeToLastCharacterMs` when the endpoint answered in one piece instead
	 * of streaming.
	 */
	readonly timeToFirstCharacterMs: number;
	/** Elapsed time, in milliseconds, from the request being sent until the final character arrived. */
	readonly timeToLastCharacterMs: number;
};

/** The completion request used by the runner, replaceable for deterministic tests. */
export type CompletionRequester = (target: BenchmarkTarget, prompt: string, timeoutMs: number) => Promise<CompletionResult>;

/** The shape of the part of a non-streaming OpenAI Chat Completions response this benchmark reads. */
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

/** The shape of the part of a streamed OpenAI Chat Completions chunk this benchmark reads. */
type ChatCompletionChunk = {
	/** The answer pieces carried by this chunk, of which only the first is read. */
	choices?: {
		/** The piece of the assistant answer this chunk carries. */
		delta?: {
			/** The answer text this chunk adds, of an unknown type until it has been checked. */
			content?: unknown;
		};
	}[];
};

/** What one decoded server-sent event of a Chat Completions stream means for this benchmark. */
type StreamEvent =
	| { readonly kind: 'content'; readonly text: string }
	| { readonly kind: 'done' }
	| { readonly kind: 'ignore' };

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
	/** The output format, still unchecked against `benchmarkReportFormats`. */
	format: string;
	/** Which endpoints to measure, still unchecked against `benchmarkTargetSelections`. */
	target: string;
};

/** The parsed command line, split into the benchmark options and the output format. */
type ParsedCommandLine = {
	/** The options that control one benchmark run. */
	options: BenchmarkOptions;
	/** Which format to print the report in. */
	format: BenchmarkReportFormat;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Benchmark
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Measures and compares the latency of two OpenAI-compatible endpoints serving the same model. */
export class Benchmark {
	/**
	 * Sends one streamed Chat Completions request to an OpenAI-compatible endpoint, so Time to
	 * First Character and Time to Last Character can be measured separately.
	 *
	 * @param target The endpoint and model to send the request to.
	 * @param prompt The single user message sent to the endpoint.
	 * @param timeoutMs The maximum time allowed for the request.
	 * @returns The assistant answer text, and when its first and last character arrived.
	 */
	static async requestOpenaiCompletion(target: BenchmarkTarget, prompt: string, timeoutMs: number): Promise<CompletionResult> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (target.apiKey !== undefined) {
			headers['Authorization'] = `Bearer ${target.apiKey}`;
		}
		const requestUrl = `${Benchmark._withoutTrailingSlash(target.baseUrl)}/chat/completions`;
		const startedAt = performance.now();
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
				stream: true,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		}).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`${target.name} could not be reached: ${reason}`);
		});
		if (response.ok === false) {
			throw await Benchmark._responseFailure(response, target);
		}
		const contentType = response.headers.get('content-type') ?? '';
		// An endpoint that ignores `stream: true` and answers as one JSON object still has to be
		// measurable: its whole answer arrives at once, so its first and last character are the
		// same moment.
		if (contentType.includes('text/event-stream') === false) {
			return Benchmark._readWholeCompletion(response, startedAt, target);
		}
		if (response.body === null) {
			throw new Error(`${target.name} sent no response body to stream`);
		}
		return Benchmark._readEventStream(response.body, startedAt, target);
	}

	/**
	 * Calculates the average, median, minimum, and maximum of each metric from measured samples.
	 *
	 * @param target The endpoint the samples were measured against.
	 * @param samples The measured samples, in request order.
	 * @returns The aggregate measurements for the endpoint.
	 */
	static summarizeSamples(target: BenchmarkTarget, samples: readonly BenchmarkSample[]): BenchmarkSummary {
		if (samples.length === 0) {
			throw new Error(`The benchmark produced no samples for ${target.name}`);
		}
		return {
			name: target.name,
			model: target.model,
			samples,
			timeToFirstCharacterMs: Benchmark._statistics(samples.map((sample) => sample.timeToFirstCharacterMs)),
			timeToLastCharacterMs: Benchmark._statistics(samples.map((sample) => sample.timeToLastCharacterMs)),
			outputCharactersPerSecond: Benchmark._statistics(samples.map((sample) => sample.outputCharactersPerSecond)),
			inputCharacters: samples[0].inputCharacters,
			outputCharacters: Benchmark._statistics(samples.map((sample) => sample.outputCharacters)),
		};
	}

	/**
	 * Runs LM Studio first and webai-at-home second, with no concurrent requests, measuring
	 * whichever of the two `options.target` selects.
	 *
	 * @param options The options that control this benchmark run.
	 * @param requester The completion request used for every measured and warm-up request.
	 * @returns The full benchmark report. It includes the direct-versus-WebAI comparison only
	 * when `options.target` is `'both'`, since there is no baseline to compare against otherwise.
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
		const directSummary = options.target === 'webai' ? undefined : await Benchmark._benchmarkTarget(options.directTarget, options, requester);
		const webaiSummary = options.target === 'direct' ? undefined : await Benchmark._benchmarkTarget(options.webaiTarget, options, requester);
		const summaries: BenchmarkSummary[] = [directSummary, webaiSummary].filter((summary): summary is BenchmarkSummary => summary !== undefined);
		const settings: BenchmarkReport['settings'] = {
			prompt: options.prompt,
			runs: options.runs,
			warmupRuns: options.warmupRuns,
			parallelism: 1,
		};
		if (directSummary === undefined || webaiSummary === undefined) {
			return {
				settings,
				summaries,
			};
		}
		return {
			settings,
			summaries,
			webaiOverhead: {
				timeToFirstCharacterMs: Benchmark._overheadComparison(directSummary.timeToFirstCharacterMs.average, webaiSummary.timeToFirstCharacterMs.average),
				timeToLastCharacterMs: Benchmark._overheadComparison(directSummary.timeToLastCharacterMs.average, webaiSummary.timeToLastCharacterMs.average),
			},
		};
	}

	/**
	 * Runs the command-line benchmark and prints its report. This is what `Cli` in `./cli.ts`
	 * calls for the `consumer_openai benchmark` subcommand.
	 *
	 * @param args The command-line arguments, without the runtime, script, and subcommand names.
	 * @returns Nothing, once the report has been printed.
	 */
	static async runCli(args: string[] = process.argv.slice(2)): Promise<void> {
		const { options, format } = Benchmark._parseOptions(args);
		const report = await Benchmark.runBenchmark(options);
		console.log(Benchmark.formatReport(report, format));
	}

	/**
	 * Writes a report out in the requested format.
	 *
	 * @param report The full benchmark report to write.
	 * @param format Which format to write.
	 * @returns The whole report as one string, ready to print.
	 */
	static formatReport(report: BenchmarkReport, format: BenchmarkReportFormat): string {
		if (format === 'json') {
			return JSON.stringify(report, null, 2);
		}
		if (format === 'markdown') {
			return Benchmark._renderMarkdownReport(report);
		}
		return Benchmark._renderTextReport(report);
	}

	/**
	 * Reports whether a string names a format `formatReport` can write.
	 *
	 * @param value The value to check, as typed on the command line.
	 * @returns `true` when the value names a format.
	 */
	static isReportFormat(value: string): value is BenchmarkReportFormat {
		return (benchmarkReportFormats as string[]).includes(value);
	}

	/**
	 * Reports whether a string names a target selection `runBenchmark` can measure.
	 *
	 * @param value The value to check, as typed on the command line.
	 * @returns `true` when the value names a target selection.
	 */
	static isTargetSelection(value: string): value is BenchmarkTargetSelection {
		return (benchmarkTargetSelections as string[]).includes(value);
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
	 * Reads a non-streamed Chat Completions response, for an endpoint that ignored `stream: true`.
	 *
	 * @param response The successful response returned by the endpoint.
	 * @param startedAt The `performance.now()` value from just before the request was sent.
	 * @param target The endpoint the request was sent to.
	 * @returns The assistant answer text, with its first and last character at the same moment.
	 */
	private static async _readWholeCompletion(response: Response, startedAt: number, target: BenchmarkTarget): Promise<CompletionResult> {
		const body = await response.json() as ChatCompletionResponse;
		const answer = body.choices?.[0]?.message?.content;
		if (typeof answer !== 'string') {
			throw new Error(`${target.name} returned no assistant answer in its Chat Completions response`);
		}
		const elapsedMs = performance.now() - startedAt;
		return {
			answer,
			timeToFirstCharacterMs: elapsedMs,
			timeToLastCharacterMs: elapsedMs,
		};
	}

	/**
	 * Reads a Chat Completions stream, timing when its first and last character arrived.
	 *
	 * @param body The response body to read as server-sent events.
	 * @param startedAt The `performance.now()` value from just before the request was sent.
	 * @param target The endpoint the request was sent to.
	 * @returns The assistant answer text, concatenated from every streamed piece, and when its
	 * first and last character arrived. Both are the elapsed time since the stream ended when
	 * the endpoint sent no content at all, so an empty answer is still measurable.
	 */
	private static async _readEventStream(body: ReadableStream<Uint8Array>, startedAt: number, target: BenchmarkTarget): Promise<CompletionResult> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let answer = '';
		let timeToFirstCharacterMs: number | undefined;
		let timeToLastCharacterMs: number | undefined;
		let isDone = false;

		while (isDone === false) {
			const { value, done } = await reader.read();
			if (done === true) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf('\n\n');
			while (boundary !== -1) {
				const rawEvent = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const event = Benchmark._parseStreamEvent(rawEvent, target);
				if (event.kind === 'done') {
					isDone = true;
					break;
				}
				if (event.kind === 'content') {
					const nowMs = performance.now() - startedAt;
					if (timeToFirstCharacterMs === undefined) {
						timeToFirstCharacterMs = nowMs;
					}
					timeToLastCharacterMs = nowMs;
					answer += event.text;
				}
				boundary = buffer.indexOf('\n\n');
			}
		}

		const elapsedMs = performance.now() - startedAt;
		return {
			answer,
			timeToFirstCharacterMs: timeToFirstCharacterMs ?? elapsedMs,
			timeToLastCharacterMs: timeToLastCharacterMs ?? elapsedMs,
		};
	}

	/**
	 * Decides what one server-sent event of a Chat Completions stream means for this benchmark:
	 * a piece of the answer, the end of the stream, or nothing worth timing.
	 *
	 * @param rawEvent One event's text, everything between two blank lines, not yet split into
	 * its `data:` lines.
	 * @param target The endpoint the event was received from, named in a parse failure.
	 * @returns What the event means.
	 * @throws {Error} If a `data:` line other than `[DONE]` is not valid JSON.
	 */
	private static _parseStreamEvent(rawEvent: string, target: BenchmarkTarget): StreamEvent {
		const dataLines = rawEvent
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice('data:'.length).trim())
			.filter((data) => data.length > 0);
		for (const data of dataLines) {
			if (data === '[DONE]') {
				return { kind: 'done' };
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(data);
			} catch {
				throw new Error(`${target.name} sent a stream chunk that was not valid JSON`);
			}
			const content = (parsed as ChatCompletionChunk).choices?.[0]?.delta?.content;
			if (typeof content === 'string' && content.length > 0) {
				return { kind: 'content', text: content };
			}
		}
		return { kind: 'ignore' };
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
			const result = await requester(target, options.prompt, options.timeoutMs);
			samples.push(Benchmark._buildSample(run, options.prompt, result));
		}
		return Benchmark.summarizeSamples(target, samples);
	}

	/**
	 * Turns one completion result into a measured sample, computing Output Characters per
	 * Second from the Time to First and Time to Last Character the requester reported.
	 *
	 * @param run The one-based measured request number.
	 * @param prompt The prompt this request sent, read for its character count.
	 * @param result The completion result to build a sample from.
	 * @returns The measured sample.
	 */
	private static _buildSample(run: number, prompt: string, result: CompletionResult): BenchmarkSample {
		// Floored at 1 ms rather than left at 0, since an answer that arrived in a single piece
		// has no streaming duration to divide by, and characters-per-second cannot be undefined.
		const streamingMs = Math.max(result.timeToLastCharacterMs - result.timeToFirstCharacterMs, 1);
		return {
			run,
			timeToFirstCharacterMs: result.timeToFirstCharacterMs,
			timeToLastCharacterMs: result.timeToLastCharacterMs,
			outputCharactersPerSecond: result.answer.length / (streamingMs / 1_000),
			inputCharacters: prompt.length,
			outputCharacters: result.answer.length,
		};
	}

	/**
	 * Calculates the average, median, minimum, and maximum of a set of measured values.
	 *
	 * @param values Every measured value, in any order. The array is not modified.
	 * @returns The metric statistics computed from the values.
	 */
	private static _statistics(values: number[]): MetricStatistics {
		const sorted = [...values].sort((left, right) => left - right);
		const total = sorted.reduce((sum, value) => sum + value, 0);
		const middle = Math.floor(sorted.length / 2);
		const median = sorted.length % 2 === 1
			? sorted[middle]
			: (sorted[middle - 1] + sorted[middle]) / 2;
		return {
			average: total / sorted.length,
			median,
			minimum: sorted[0],
			maximum: sorted[sorted.length - 1],
		};
	}

	/**
	 * Compares webai-at-home's average against the direct baseline for one metric.
	 *
	 * @param directAverage The direct endpoint's average for this metric.
	 * @param webaiAverage The webai-at-home endpoint's average for this metric.
	 * @returns The added average and its share of the direct average.
	 */
	private static _overheadComparison(directAverage: number, webaiAverage: number): OverheadComparison {
		const averageMs = webaiAverage - directAverage;
		const percentOfDirectAverage = directAverage === 0 ? 0 : (averageMs / directAverage) * 100;
		return {
			averageMs,
			percentOfDirectAverage,
		};
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
			.option('-f, --format <format>', `output format: ${benchmarkReportFormats.join(', ')}`, 'text')
			.option('-t, --target <target>', `which endpoint to measure: ${benchmarkTargetSelections.join(', ')}`, 'both');
		const raw = program.parse(args, { from: 'user' }).opts<RawOptions>();
		if (Benchmark.isReportFormat(raw.format) === false) {
			throw new Error(`--format must be one of ${benchmarkReportFormats.join(', ')}`);
		}
		if (Benchmark.isTargetSelection(raw.target) === false) {
			throw new Error(`--target must be one of ${benchmarkTargetSelections.join(', ')}`);
		}
		return {
			options: {
				directTarget: Benchmark._buildTarget('LM Studio', raw.directBaseUrl, raw.directModel, raw.apiKey),
				webaiTarget: Benchmark._buildTarget('webai-at-home', raw.webaiBaseUrl, raw.webaiModel, raw.apiKey),
				target: raw.target,
				prompt: raw.prompt,
				runs: Benchmark._positiveInteger(raw.runs, '--runs'),
				warmupRuns: Benchmark._positiveInteger(raw.warmupRuns, '--warmup-runs', true),
				timeoutMs: Benchmark._positiveInteger(raw.timeoutMs, '--timeout-ms'),
			},
			format: raw.format,
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
	 * Renders the report as the compact human-readable text printed to a terminal.
	 *
	 * @param report The full benchmark report to render.
	 * @returns The whole report as one string.
	 */
	private static _renderTextReport(report: BenchmarkReport): string {
		const lines: string[] = [
			`OpenAI API benchmark (parallelism: ${report.settings.parallelism})`,
			`Measured requests per endpoint: ${report.settings.runs}; warm-up requests: ${report.settings.warmupRuns}`,
		];
		for (const summary of report.summaries) {
			lines.push(`${summary.name} (${summary.model})`);
			lines.push(`  TTFC:   ${Benchmark._rounded(summary.timeToFirstCharacterMs.average)} ms average, ${Benchmark._rounded(summary.timeToFirstCharacterMs.median)} ms median, ${Benchmark._rounded(summary.timeToFirstCharacterMs.minimum)}–${Benchmark._rounded(summary.timeToFirstCharacterMs.maximum)} ms range`);
			lines.push(`  TTLC:   ${Benchmark._rounded(summary.timeToLastCharacterMs.average)} ms average, ${Benchmark._rounded(summary.timeToLastCharacterMs.median)} ms median, ${Benchmark._rounded(summary.timeToLastCharacterMs.minimum)}–${Benchmark._rounded(summary.timeToLastCharacterMs.maximum)} ms range`);
			lines.push(`  OCPS:   ${Benchmark._rounded(summary.outputCharactersPerSecond.average)} characters/second average`);
			lines.push(`  input:  ${summary.inputCharacters} characters`);
			lines.push(`  output: ${Benchmark._rounded(summary.outputCharacters.average)} characters average`);
		}
		if (report.webaiOverhead !== undefined) {
			lines.push(
				`webai-at-home TTFC overhead: ${Benchmark._rounded(report.webaiOverhead.timeToFirstCharacterMs.averageMs)} ms per request ` +
					`(${Benchmark._rounded(report.webaiOverhead.timeToFirstCharacterMs.percentOfDirectAverage)}% of the direct average)`,
			);
			lines.push(
				`webai-at-home TTLC overhead: ${Benchmark._rounded(report.webaiOverhead.timeToLastCharacterMs.averageMs)} ms per request ` +
					`(${Benchmark._rounded(report.webaiOverhead.timeToLastCharacterMs.percentOfDirectAverage)}% of the direct average)`,
			);
		}
		return lines.join('\n');
	}

	/**
	 * Renders the report as markdown, so it can be pasted straight into an issue, a pull
	 * request, or a notes file and still read as a report.
	 *
	 * @param report The full benchmark report to render.
	 * @returns The whole report as one markdown document.
	 */
	private static _renderMarkdownReport(report: BenchmarkReport): string {
		const blocks: string[] = [
			'# OpenAI API benchmark',
			`Parallelism: ${report.settings.parallelism} · measured requests per endpoint: ${report.settings.runs} · warm-up requests: ${report.settings.warmupRuns}`,
			[
				'| Endpoint | Model | TTFC | TTLC | OCPS | Input chars | Output chars |',
				'| --- | --- | ---: | ---: | ---: | ---: | ---: |',
				...report.summaries.map((summary) => [
					'|',
					summary.name,
					'|',
					summary.model,
					`| ${Benchmark._rounded(summary.timeToFirstCharacterMs.average)} ms`,
					`| ${Benchmark._rounded(summary.timeToLastCharacterMs.average)} ms`,
					`| ${Benchmark._rounded(summary.outputCharactersPerSecond.average)} chars/s`,
					`| ${summary.inputCharacters}`,
					`| ${Benchmark._rounded(summary.outputCharacters.average)} |`,
				].join(' ')),
			].join('\n'),
		];
		if (report.webaiOverhead !== undefined) {
			blocks.push(
				`webai-at-home TTFC overhead: **${Benchmark._rounded(report.webaiOverhead.timeToFirstCharacterMs.averageMs)} ms** per request `
					+ `(${Benchmark._rounded(report.webaiOverhead.timeToFirstCharacterMs.percentOfDirectAverage)}% of the direct average)`,
			);
			blocks.push(
				`webai-at-home TTLC overhead: **${Benchmark._rounded(report.webaiOverhead.timeToLastCharacterMs.averageMs)} ms** per request `
					+ `(${Benchmark._rounded(report.webaiOverhead.timeToLastCharacterMs.percentOfDirectAverage)}% of the direct average)`,
			);
		}
		return `${blocks.join('\n\n')}\n`;
	}
}
