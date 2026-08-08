///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	completion_types — every data shape the three subcommands share
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Sending One Request
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One mode a chat completion request can be sent in. */
export type CompletionMode = 'nostream' | 'streamed';

/** Every mode a subcommand can sweep through, in the order they run for one model. */
export const completionModes: readonly CompletionMode[] = ['nostream', 'streamed'];

/** The endpoint one request is sent to. */
export type CompletionTarget = {
	/** The base URL of the OpenAI-compatible API, without `/chat/completions`. */
	readonly baseUrl: string;
	/** The bearer token sent to the endpoint. */
	readonly apiKey: string;
	/** How long one request may take before it is given up on, in milliseconds. */
	readonly timeoutMs: number;
};

/** What sending one request, given a full list of messages, produced. */
export type CompletionResult = {
	/** The complete assistant answer, concatenated from every streamed piece in the streamed mode. */
	readonly answer: string;
	/**
	 * Elapsed time, in milliseconds, from the request being sent until the first character
	 * arrived. Equal to `timeToLastCharacterMs` in the nostream mode, and equal to it as well
	 * when the endpoint ignored the streaming request and answered in one piece.
	 */
	readonly timeToFirstCharacterMs: number;
	/** Elapsed time, in milliseconds, from the request being sent until the final character arrived. */
	readonly timeToLastCharacterMs: number;
	/**
	 * How much of `timeToLastCharacterMs` was spent generating the whole answer inside the
	 * cluster, read from the `X-Webai-Generation-Time-Ms` response header, rather than measured
	 * by this tool's own stopwatch. Set only in the nostream mode, since only a whole-answer
	 * response can carry it — a streamed response sends its headers before the cluster has
	 * finished generating the rest of the answer. `undefined` when the endpoint sent no such
	 * header, which every endpoint other than this project's own `consumer_openai` server does.
	 */
	readonly clusterGenerationTimeMs: number | undefined;
	/**
	 * How much of `timeToFirstCharacterMs` was spent inside the cluster before its first piece
	 * was ready, read from the `X-Webai-Time-To-First-Piece-Ms` response header. Set only in the
	 * streamed mode. `undefined` when the endpoint sent no such header.
	 */
	readonly clusterTimeToFirstPieceMs: number | undefined;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Sweeping Across Models
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How one swept model and mode pair turned out. */
export type SweepStatus = 'ok' | 'failed' | 'skipped';

/** One message of a conversation `history` sent, in the order it was sent. */
export type SweepTurn = {
	/** Who sent the message. */
	readonly role: 'user' | 'assistant';
	/** The message text. */
	readonly content: string;
};

/** What sweeping one model and one mode produced, for `completion` and `history`. */
export type SweepOutcome = {
	/** The model identifier swept. */
	readonly modelId: string;
	/** The mode swept. */
	readonly mode: CompletionMode;
	/**
	 * `ok` once the model answered with usable text, `failed` once it did not, and `skipped`
	 * for a pairing known ahead of the request not to work, such as `dev_formula` asked to
	 * stream, so that a permanent, documented restriction of the cluster does not read as a
	 * failure of this run.
	 */
	readonly status: SweepStatus;
	/**
	 * Elapsed time, in milliseconds, from the request being sent until the first character
	 * arrived. Equal to `timeToLastCharacterMs` in the nostream mode. `0` when skipped.
	 */
	readonly timeToFirstCharacterMs: number;
	/** Elapsed time, in milliseconds, from the request being sent until the final character arrived. `0` when skipped. */
	readonly timeToLastCharacterMs: number;
	/** The number of characters of the answer, `0` when not `ok`. */
	readonly characterCount: number;
	/** The raw answer text, already printed as it was produced. Empty when not `ok`. */
	readonly answer: string;
	/**
	 * How much of `timeToLastCharacterMs` the cluster reported spending on generation, carried
	 * over from `CompletionResult.clusterGenerationTimeMs`. Set only for an `ok` pairing in the
	 * nostream mode, against an endpoint that sent the header. `undefined` otherwise.
	 */
	readonly clusterGenerationTimeMs?: number | undefined;
	/**
	 * How much of `timeToFirstCharacterMs` the cluster reported spending before its first piece
	 * was ready, carried over from `CompletionResult.clusterTimeToFirstPieceMs`. Set only for an
	 * `ok` pairing in the streamed mode, against an endpoint that sent the header. `undefined`
	 * otherwise.
	 */
	readonly clusterTimeToFirstPieceMs?: number | undefined;
	/** Why the pair failed or was skipped, `undefined` on success. */
	readonly failureMessage: string | undefined;
	/**
	 * Every message of the conversation, in the order it was sent, as far as the sweep got. Only
	 * `history` sets this, since it is the only subcommand that sends a whole conversation rather
	 * than one prompt; left out entirely for `completion`, rather than set to `undefined`, so it
	 * does not appear in a `completion` sweep's JSON report.
	 */
	readonly turns?: readonly SweepTurn[];
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Measuring Latency
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

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
	 * Time to First Character: elapsed time, in milliseconds, from the request being sent until
	 * the first streamed character arrived. Measures perceived responsiveness.
	 */
	readonly timeToFirstCharacterMs: number;
	/**
	 * Time to Last Character: elapsed time, in milliseconds, from the request being sent until
	 * the final character arrived. Measures end-to-end request latency.
	 */
	readonly timeToLastCharacterMs: number;
	/**
	 * Output Characters per Second: the speed at which the endpoint streamed the answer after
	 * its first character, computed as `outputCharacters / (the Time to Last Character minus
	 * the Time to First Character, in seconds)`.
	 */
	readonly outputCharactersPerSecond: number;
	/** Input Characters: the number of characters sent in the request prompt. */
	readonly inputCharacters: number;
	/** Output Characters: the number of characters generated in the response. */
	readonly outputCharacters: number;
};

/** The aggregate measurements for one measured model on one endpoint. */
export type BenchmarkSummary = {
	/** The base URL of the endpoint measured. */
	readonly baseUrl: string;
	/** The model identifier measured on that endpoint. */
	readonly modelId: string;
	/** The measured samples, in request order. */
	readonly samples: readonly BenchmarkSample[];
	/** Time to First Character, across the measured samples. */
	readonly timeToFirstCharacterMs: MetricStatistics;
	/** Time to Last Character, across the measured samples. */
	readonly timeToLastCharacterMs: MetricStatistics;
	/** Output Characters per Second, across the measured samples. */
	readonly outputCharactersPerSecond: MetricStatistics;
	/** Input Characters sent in the prompt, the same for every sample since one prompt is sent every time. */
	readonly inputCharacters: number;
	/** Output Characters generated in the response, across the measured samples. */
	readonly outputCharacters: MetricStatistics;
};

/** The full benchmark report, holding one summary per measured model. */
export type BenchmarkReport = {
	/** The benchmark settings that affect comparability with another run. */
	readonly settings: {
		/** The one prompt sent to the endpoint. */
		readonly prompt: string;
		/** The number of measured requests per model. */
		readonly runs: number;
		/** The number of unreported warm-up requests per model. */
		readonly warmupRuns: number;
		/** The number of requests in flight at any moment, always one. */
		readonly parallelism: 1;
	};
	/** The aggregate measurements, one entry per measured model, in the order they were measured. */
	readonly summaries: readonly BenchmarkSummary[];
};

/** The ways a benchmark report, or a completion/history sweep report, can be written out. */
export type ReportFormat = 'text' | 'markdown' | 'json';

/** Every format all three subcommands accept, in the order the help text lists them. */
export const reportFormats: readonly ReportFormat[] = ['text', 'markdown', 'json'];
