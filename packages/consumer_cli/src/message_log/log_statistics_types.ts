///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LogStatisticsTypes — the shape of the report `log_stats` measures and prints
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * How one measured set of numbers is spread out.
 *
 * The percentiles matter more than the mean for anything measuring time: one slow request in
 * a hundred is invisible in an average and obvious at the 99th percentile, and a cluster is
 * judged by its slow answers rather than by its typical ones.
 */
export type Distribution = {
	/** How many values were measured. */
	count: number;
	/** The smallest value, or 0 when nothing was measured. */
	minimum: number;
	/** The value half the measurements fall below. */
	median: number;
	/** The value 90 measurements in 100 fall below. */
	percentile90: number;
	/** The value 99 measurements in 100 fall below. */
	percentile99: number;
	/** The largest value, or 0 when nothing was measured. */
	maximum: number;
	/** The arithmetic mean, or 0 when nothing was measured. */
	mean: number;
	/** Every measured value added together. */
	total: number;
};

/** What the log file itself is, before anything in it is measured. */
export type FileSection = {
	/** The path the file was read from. */
	filePath: string;
	/** The size of the file on disk, in bytes. */
	fileBytes: number;
	/** How many non-empty lines the file held. */
	lineCount: number;
	/** How many of those lines were readable as a log entry. */
	entryCount: number;
	/** How many lines were skipped because they could not be read. */
	unreadableLineCount: number;
	/** Every protocol version the recorded messages stated, smallest first. */
	protocolVersions: number[];
};

/** When the recorded traffic happened, and how evenly it was spread over that time. */
export type TimeSpanSection = {
	/** The moment of the earliest message, in ISO 8601 format. */
	firstTimestamp: string | undefined;
	/** The moment of the latest message, in ISO 8601 format. */
	lastTimestamp: string | undefined;
	/** How long the file covers, from the earliest message to the latest, in milliseconds. */
	durationMs: number;
	/** Messages per second, averaged over the whole duration. */
	messagesPerSecond: number;
	/** How many messages fell in the busiest single second. */
	busiestSecondMessageCount: number;
	/** The start of the busiest single second, in ISO 8601 format. */
	busiestSecondTimestamp: string | undefined;
	/** How the delays between one message and the next are spread out, in milliseconds. */
	gapMs: Distribution;
	/** The longest stretch with no message at all, in milliseconds. */
	longestSilenceMs: number;
	/** The moment the longest silence began, in ISO 8601 format. */
	longestSilenceStartsAt: string | undefined;
};

/** How much was sent, in how many messages, and how much of it was protocol rather than content. */
export type TrafficSection = {
	/** How many messages were recorded. */
	messageCount: number;
	/** How many of them were sent to the counterpart. */
	sentCount: number;
	/** How many of them were received from the counterpart. */
	receivedCount: number;
	/** The total size on the wire of the sent messages, in bytes. */
	sentBytes: number;
	/** The total size on the wire of the received messages, in bytes. */
	receivedBytes: number;
	/** How the size on the wire of a single message is spread out, in bytes. */
	messageBytes: Distribution;
	/** How the size of a single message body, without its envelope, is spread out, in bytes. */
	messagePayloadBytes: Distribution;
	/** The wire bytes that carried the envelope rather than the message body. */
	envelopeOverheadBytes: number;
	/** What share of the wire bytes the envelope took, as a percentage. */
	envelopeOverheadPercent: number;
	/** How many messages carried a body byte-for-byte identical to one already recorded. */
	repeatedBodyCount: number;
	/** The bytes those repeated bodies cost, in bytes. */
	repeatedBodyBytes: number;
	/** The single largest message recorded. */
	largestMessage: LargestMessage | undefined;
};

/** The single largest message a log file recorded. */
export type LargestMessage = {
	/** The message's `type` field. */
	messageType: string;
	/** Its size on the wire, in bytes. */
	messageBytes: number;
	/** When it was recorded, in ISO 8601 format. */
	timestamp: string;
};

/** One message type, and how much of the file it accounts for. */
export type MessageTypeRow = {
	/** The message's `type` field, for example `task.updated`. */
	messageType: string;
	/** How many messages of this type were recorded. */
	count: number;
	/** What share of all messages this type is, as a percentage. */
	countPercent: number;
	/** How many of them were sent to the counterpart. */
	sentCount: number;
	/** How many of them were received from the counterpart. */
	receivedCount: number;
	/** The total size on the wire of this type, in bytes. */
	messageBytes: number;
	/** What share of all wire bytes this type is, as a percentage. */
	bytesPercent: number;
	/** The mean size on the wire of one message of this type, in bytes. */
	meanMessageBytes: number;
};

/** One counterpart of the actor that wrote the log, and how much it exchanged. */
export type CounterpartRow = {
	/** The counterpart's role: `consumer`, `worker`, `observer`, `gateway`, or `unknown`. */
	role: string;
	/** The counterpart's device identifier, or `unknown` before one was assigned. */
	deviceId: string;
	/** How many messages were exchanged with this counterpart. */
	count: number;
	/** The total size on the wire of those messages, in bytes. */
	messageBytes: number;
	/** The moment of the first message exchanged with it, in ISO 8601 format. */
	firstSeenAt: string;
	/** The moment of the last message exchanged with it, in ISO 8601 format. */
	lastSeenAt: string;
};

/** One kind of request and reply, and how long the reply took. */
export type ExchangeRow = {
	/** The request and reply message types, written as `request → reply`. */
	exchange: string;
	/** How many such exchanges were matched. */
	count: number;
	/** How the reply delay is spread out, in milliseconds. */
	latencyMs: Distribution;
};

/** How long replies took, measured by matching each reply to the request it answers. */
export type ReplySection = {
	/** How many replies were matched to the request they answer. */
	matchedCount: number;
	/** How many replies named a request that this file does not contain. */
	unmatchedReplyCount: number;
	/** How the reply delay is spread out across every matched exchange, in milliseconds. */
	latencyMs: Distribution;
	/** The slowest matched exchange. */
	slowestExchange: SlowestExchange | undefined;
	/** One row per kind of request and reply, slowest median first. */
	byExchange: ExchangeRow[];
};

/** The slowest matched request and reply a log file recorded. */
export type SlowestExchange = {
	/** The request and reply message types, written as `request → reply`. */
	exchange: string;
	/** How long the reply took, in milliseconds. */
	latencyMs: number;
	/** When the reply was recorded, in ISO 8601 format. */
	timestamp: string;
};

/** One grouping key and how many tasks fall under it. */
export type TaskGroupRow = {
	/** The worker device, task type, or final state this row counts. */
	key: string;
	/** How many tasks fall under it. */
	count: number;
};

/** What happened to the tasks the log file recorded. */
export type TaskSection = {
	/** How many distinct tasks the file mentions. */
	taskCount: number;
	/** How many of them reached `completed`. */
	completedCount: number;
	/** How many of them reached `failed`. */
	failedCount: number;
	/** How many of them reached `cancelled`. */
	cancelledCount: number;
	/** How many of them the file never shows finishing, one way or the other. */
	unfinishedCount: number;
	/** How many of them had a stage retried, so their highest attempt number is above 1. */
	retriedCount: number;
	/** The highest attempt number any task reached. */
	maximumAttempt: number;
	/** How long the gateway took to answer a submission, in milliseconds. */
	admissionMs: Distribution;
	/** How long a task waited from being accepted until its first stage was assigned. */
	queueWaitMs: Distribution;
	/** How long a task took from being submitted until it finished, in milliseconds. */
	endToEndMs: Distribution;
	/** How many stage runs a single task needed, which is above 1 when it is answered in pieces. */
	stageRunsPerTask: Distribution;
	/** How many messages a single task cost. */
	messagesPerTask: Distribution;
	/** The total size on the wire of one task's messages, in bytes. */
	bytesPerTask: Distribution;
	/** How many tasks each final state accounts for, most common first. */
	byFinalState: TaskGroupRow[];
	/** How many tasks each task type accounts for, most common first. */
	byTaskType: TaskGroupRow[];
	/** How many tasks each worker device was given a stage of, most first. */
	byWorker: TaskGroupRow[];
};

/** One stage name or worker device, and how its stage runs were timed. */
export type StageGroupRow = {
	/** The stage name or worker device this row measures. */
	key: string;
	/** How many stage runs fall under it. */
	count: number;
	/** How long the worker took to produce the answer, in milliseconds. */
	computeMs: Distribution;
};

/** What happened to each individual run of a stage on a worker. */
export type StageRunSection = {
	/** How many stage runs the file mentions. */
	stageRunCount: number;
	/** How many of them the file never shows a result for. */
	unfinishedCount: number;
	/** How long a worker took to confirm it had taken an assigned stage, in milliseconds. */
	pickupMs: Distribution;
	/** How long a worker took to produce the answer after taking the stage, in milliseconds. */
	computeMs: Distribution;
	/** How long the gateway took to record a result once the worker sent it, in milliseconds. */
	commitMs: Distribution;
	/** One row per stage name, slowest median compute time first. */
	byStageName: StageGroupRow[];
	/** One row per worker device, slowest median compute time first. */
	byWorker: StageGroupRow[];
};

/** Everything about the file that is worth a second look. */
export type ConcernSection = {
	/** How many lines could not be read as a log entry. */
	unreadableLineCount: number;
	/** The first few unreadable lines, described one per entry. */
	unreadableLineSamples: string[];
	/** How many messages carried a timestamp earlier than the message recorded before them. */
	outOfOrderCount: number;
	/** How many messages report a failure, a rejection, or a cancellation. */
	errorMessageCount: number;
	/** One row per failure, rejection, or cancellation message type, most common first. */
	errorMessageTypes: TaskGroupRow[];
	/** How many message bodies were too large to record and were replaced by a marker. */
	oversizeBodyCount: number;
	/** How many messages named no device, because the counterpart had not registered yet. */
	unidentifiedCounterpartCount: number;
};

/** Everything `log_stats` measures about one `.log_entry.jsonl` file. */
export type LogStatisticsReport = {
	/** What the file itself is. */
	file: FileSection;
	/** When the traffic happened. */
	timeSpan: TimeSpanSection;
	/** How much was sent. */
	traffic: TrafficSection;
	/** One row per message type, most frequent first. */
	byMessageType: MessageTypeRow[];
	/** One row per counterpart, most messages first. */
	byCounterpart: CounterpartRow[];
	/** How long replies took. */
	reply: ReplySection;
	/** What happened to the tasks. */
	tasks: TaskSection;
	/** What happened to each stage run. */
	stageRuns: StageRunSection;
	/** Everything worth a second look. */
	concerns: ConcernSection;
};
