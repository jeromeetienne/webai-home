import { StagePayloadFactory, type LlmStagePayload } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageLlmGemmaNanoChromeHelper — runs the language model built into the browser
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * How ready the browser's built-in language model is, as the browser reports it.
 *
 * `unavailable` means this browser will not run the model at all. `downloadable` means the
 * browser has the model on offer but has not downloaded it yet, and `downloading` means a
 * download is under way; in both of those the browser refuses to create a session unless the
 * person using the page has just interacted with it. `available` means a session can be
 * created straight away.
 */
type BuiltInModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** One generation held open by the browser's built-in language model. */
type BuiltInModelSession = {
	/** Asks for an answer and returns it in pieces as they are produced. */
	promptStreaming(prompt: string): ReadableStream<string>;
	/** Releases the session and the memory the browser holds for it. */
	destroy(): void;
};

/**
 * How a download of the built-in model reports its progress.
 *
 * The browser passes an event target, but only this one event is used here, so only this one
 * way of listening for it is declared.
 */
type BuiltInModelDownloadMonitor = {
	addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void;
};

/** The browser object that reports on, and creates sessions with, the built-in language model. */
type BuiltInModelFactory = {
	availability(): Promise<BuiltInModelAvailability>;
	create(options?: { monitor?: (monitor: BuiltInModelDownloadMonitor) => void }): Promise<BuiltInModelSession>;
};

/**
 * Whether this browser can run the stage, and what has to happen first when it cannot yet.
 *
 * `user_gesture_required` is not a failure. The browser has the model on offer but will only
 * start the download from a button the person using the page presses themselves, so the page
 * has to ask for that press before this browser can offer the stage.
 */
export type BuiltInModelReadiness =
	| { status: 'ready' }
	| { status: 'user_gesture_required'; message: string }
	| { status: 'unavailable'; message: string };

/** One answer this browser is producing, kept in memory while its stage run reads it. */
type TaskGenerationState = {
	/**
	 * The session the answer is being generated in, absent until the browser has created it.
	 *
	 * A state exists before its session does, because creating the session is the slowest part
	 * of a run and the assignment can be taken away while it is happening. See `isReleased`.
	 */
	session: BuiltInModelSession | undefined;
	/** The reader that delivers the answer one piece at a time, absent until the session exists. */
	reader: ReadableStreamDefaultReader<string> | undefined;
	/** The pieces of the answer received so far, joined. */
	text: string;
	/** How many pieces have been read, which bounds how long one stage run may read for. */
	pieceCount: number;
	/**
	 * Whether {@link StageLlmGemmaNanoChromeHelper.clearAssignment} has released this
	 * generation while the stage run still had it in hand.
	 *
	 * It is read at the two points a run can learn that its work is no longer wanted. After a
	 * read, because releasing cancels the reader and a cancelled reader ends the read that was
	 * waiting on it as if the model had finished the answer, so this is what tells the two
	 * apart and reports an abandoned answer as a failure rather than as a complete one. And
	 * after the session is created, because a release that arrives before the session exists
	 * has no reader to cancel and no session to destroy, and would otherwise leave the browser
	 * generating a whole answer for a task nobody is waiting for.
	 */
	isReleased: boolean;
};

/**
 * The largest number of pieces one answer may be read in.
 *
 * A model that never finished an answer would otherwise keep one stage run reading for as
 * long as the page is open. This is the same kind of bound as the generated-token limit of
 * the sharded Qwen3 task.
 */
const MAXIMUM_ANSWER_PIECES = 400;

/**
 * Runs the language model built into the browser, producing a whole answer in one stage run.
 *
 * Nothing is downloaded by the project for this task. The browser holds the model, so the
 * only thing this helper keeps is the open generation: the session and the reader that
 * delivers the answer.
 *
 * The browser produces an answer in pieces, and one stage run reads every piece of one answer
 * before it returns. Reading one piece per stage run instead would cost one message to the
 * central gateway and one message back for each piece, and each of those messages would carry
 * the whole answer so far, so the traffic for one answer would grow with the square of its
 * length. The gateway learns nothing from those rounds that it does not learn from the single
 * result, because a consumer is not told the text of a task until the task has completed.
 * This is the work of https://github.com/webai-at-home/webai-at-home/issues/77, whose later
 * steps bring the piece-at-a-time reading back for a request that asks for its answer to be
 * streamed.
 *
 * One stage run can therefore last as long as a whole answer takes. That is safe because the
 * worker browser page sends `stage.heartbeat` for the whole time a stage is running, which
 * moves the assignment lease along ahead of it.
 *
 * The interface used here is the browser's own prompt interface, reached through the global
 * `LanguageModel` object. It is not part of the browser type definitions this project
 * compiles against, so the small part of it that is used is declared above.
 */
export class StageLlmGemmaNanoChromeHelper {
	/**
	 * The computation this worker browser implements, named the way a pipeline stage names
	 * its computation.
	 */
	static readonly computation = 'llm_gemma_nano_chrome_full';

	/**
	 * Reports whether this helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return computation === StageLlmGemmaNanoChromeHelper.computation;
	}

	/**
	 * The generations this browser is currently producing, by assignment identifier.
	 *
	 * A generation is held here only while its own stage run has it in hand. It is kept in a map
	 * rather than in a local variable of that run so that `clearAssignment` can reach it, which
	 * is how a cancelled task stops the browser generating an answer nobody will read.
	 *
	 * The key is the assignment and not the task, because one browser tab can hold two runs of
	 * the same task at once: a lease that expires while a run is under way has the gateway
	 * assign the stage again, and this stage asks for that retry to come back to the same tab.
	 * The gateway issues a fresh assignment identifier for every attempt, so keying by it gives
	 * each run its own entry, and neither run can release the other's session.
	 */
	private static stateByAssignmentId = new Map<string, TaskGenerationState>();

	/**
	 * Reports whether this browser can run the stage, without asking it to download anything.
	 *
	 * This is asked before the browser advertises the stage, so a browser with no built-in
	 * model says so at once instead of accepting work it would fail.
	 *
	 * @returns Whether the stage can be run, and what has to happen first when it cannot yet.
	 */
	static async readiness(): Promise<BuiltInModelReadiness> {
		const factory = StageLlmGemmaNanoChromeHelper.factory();
		if (factory === undefined) return { status: 'unavailable', message: 'This browser has no built-in language model. Chrome 138 or a later version is needed, on a desktop computer that meets its requirements.' };
		const availability = await factory.availability();
		if (availability === 'unavailable') {
			if (StageLlmGemmaNanoChromeHelper.isDeniedToThisPage()) return { status: 'unavailable', message: "This page is not allowed to use the browser's built-in language model. A page shown inside a frame from a different address is not allowed to by default, and the page around it has to pass the permission on by setting allow=\"language-model\" on the frame." };
			return { status: 'unavailable', message: 'This browser has a built-in language model but will not run it on this device. Its storage, memory, or graphics requirements are usually the reason.' };
		}
		if (availability === 'available') return { status: 'ready' };
		return { status: 'user_gesture_required', message: 'The browser has not downloaded its built-in language model yet, and it only starts that download when the person using the page asks for it.' };
	}

	/**
	 * Downloads the built-in language model, and must be called from a button press.
	 *
	 * The browser refuses to create a session while the model still has to be downloaded
	 * unless the page was just interacted with, so this cannot be done as part of loading the
	 * page. The session created here is released immediately; the point of creating it is
	 * that doing so is what starts the download.
	 *
	 * @param onProgress Called with how much of the model has been downloaded, from 0 to 1.
	 * @returns Whether the stage can be run now.
	 */
	static async download(onProgress: (fraction: number) => void): Promise<BuiltInModelReadiness> {
		const factory = StageLlmGemmaNanoChromeHelper.factory();
		if (factory === undefined) return { status: 'unavailable', message: 'This browser has no built-in language model.' };
		const session = await factory.create({
			monitor: (monitor) => monitor.addEventListener('downloadprogress', (event) => onProgress(event.loaded)),
		});
		session.destroy();
		return StageLlmGemmaNanoChromeHelper.readiness();
	}

	/**
	 * Produces one assignment's whole answer, reading every piece the browser gives before
	 * returning.
	 *
	 * @param assignmentId The assignment this run is carrying out, which names the generation
	 * held for it while the run has it in hand.
	 * @param payload The prompt submitted with the task.
	 * @returns The complete answer, marked as finished.
	 * @throws If the browser has no built-in language model, if the payload continues an answer
	 * rather than carrying a prompt, if the answer is abandoned before or while it is being
	 * read, or if the model reports an error.
	 */
	static async compute(assignmentId: string, payload: LlmStagePayload): Promise<LlmStagePayload> {
		// No stage run produces a continuation any more, so none can arrive. One that did would
		// carry an answer this browser is not holding, and reading it as a prompt would answer
		// the model's own words instead of the reader's question.
		if (payload.isContinuation === true) throw new Error('This stage produces a whole answer in one run, so there is no answer left open here for a later run to continue.');
		// The state is registered before the session it will hold is asked for, so that an
		// assignment taken away during that wait has something to mark released.
		const state: TaskGenerationState = { session: undefined, reader: undefined, text: '', pieceCount: 0, isReleased: false };
		StageLlmGemmaNanoChromeHelper.stateByAssignmentId.set(assignmentId, state);
		try {
			const reader = await StageLlmGemmaNanoChromeHelper.startGeneration(state, payload.text ?? '');
			while (state.pieceCount < MAXIMUM_ANSWER_PIECES) {
				const piece = await reader.read();
				if (state.isReleased === true) throw new Error('The answer this stage was producing was abandoned before the model had finished it.');
				if (piece.done === true) break;
				state.text += piece.value;
				state.pieceCount += 1;
			}
			return StagePayloadFactory.llmDone(state.text);
		} finally {
			StageLlmGemmaNanoChromeHelper.clearAssignment(assignmentId);
		}
	}

	/**
	 * Releases the generation this browser holds for one assignment.
	 *
	 * Called once an answer has been read, and also when a stage fails or its assignment is
	 * taken away, so an abandoned run does not leave a model session open and does not leave
	 * the browser generating an answer nobody will read.
	 *
	 * @param assignmentId The assignment whose generation should be released.
	 */
	static clearAssignment(assignmentId: string): void {
		const state = StageLlmGemmaNanoChromeHelper.stateByAssignmentId.get(assignmentId);
		if (state === undefined) return;
		StageLlmGemmaNanoChromeHelper.stateByAssignmentId.delete(assignmentId);
		// Set before either of the two below, because both are how a run that is waiting learns
		// it has been released, and because neither exists yet when the release arrives while
		// the session is still being created. In that case this flag is the only signal, and
		// `startGeneration` is where it is read.
		state.isReleased = true;
		if (state.reader !== undefined) void state.reader.cancel().catch(() => undefined);
		if (state.session !== undefined) state.session.destroy();
	}

	/**
	 * Starts one answer, and hands its session and reader to the state the run holds.
	 *
	 * Asking for the answer does not wait for it. The model returns a stream at once and
	 * produces the answer into it, so the caller reads every piece from that stream.
	 *
	 * @param state The generation state this run registered, already released or not.
	 * @param prompt The prompt submitted with the task.
	 * @returns The reader that delivers the answer.
	 * @throws If the prompt is empty, if this browser has no built-in language model, or if the
	 * assignment was taken away while the browser was creating the session.
	 */
	private static async startGeneration(state: TaskGenerationState, prompt: string): Promise<ReadableStreamDefaultReader<string>> {
		if (prompt.trim() === '') throw new Error('A prompt is needed to start an answer.');
		const factory = StageLlmGemmaNanoChromeHelper.factory();
		if (factory === undefined) throw new Error('This browser has no built-in language model.');
		const session = await factory.create();
		// Creating the session is the slowest part of a run — on a device that has only just
		// downloaded the model it took about 15 seconds in testing — and the assignment can be
		// taken away while it is happening. A release that arrives then finds no session to
		// destroy and no reader to cancel, so it leaves this flag and nothing else; reading it
		// here is what stops the browser generating a whole answer for a task that was already
		// given up on before its session existed.
		if (state.isReleased === true) {
			session.destroy();
			throw new Error('The answer this stage was to produce was abandoned before the model session was ready.');
		}
		state.session = session;
		state.reader = session.promptStreaming(prompt).getReader();
		return state.reader;
	}

	/** The browser object that creates sessions with the built-in language model, when it exists. */
	private static factory(): BuiltInModelFactory | undefined {
		return (globalThis as { LanguageModel?: BuiltInModelFactory }).LanguageModel;
	}

	/**
	 * Reports whether this page has been refused permission to use the built-in language model.
	 *
	 * The browser answers `unavailable` for two quite different situations: it will not run the
	 * model on this device, or this page is not allowed to use it. Only the second can be
	 * recognised, and this is how, so that a page inside a frame is not told its device is at
	 * fault when the frame was simply never given the permission.
	 *
	 * @returns `true` when the permission is known to have been refused, and `false` both when
	 * it was granted and when the browser offers no way to ask.
	 */
	private static isDeniedToThisPage(): boolean {
		const featurePolicy = (document as { featurePolicy?: { allowsFeature(feature: string): boolean } }).featurePolicy;
		if (featurePolicy === undefined) return false;
		return featurePolicy.allowsFeature('language-model') === false;
	}
}
