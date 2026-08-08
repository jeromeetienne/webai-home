import { StagePayloadFactory, type GenerationSettings, type LlmStagePayload } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageHelperLlmGemmaNanoChromeFull — runs the language model built into the browser
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

/** One answer this browser is producing, kept in memory while its stage runs read it. */
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
	/**
	 * The assignment whose run currently has this generation in hand.
	 *
	 * One tab can hold two runs of one task at once: a lease that expires while a run is under
	 * way has the gateway assign the stage again, and this stage asks for that retry to come
	 * back to the same tab. Each run releases the generation when it is finished with it, and
	 * only the run named here may, so the run that was replaced cannot release the generation
	 * its replacement is reading.
	 */
	owningStageAssignmentId: string;
	/**
	 * What has been read from the model but not yet returned as a stage result.
	 *
	 * A run that is replaced while it is waiting for a piece still receives that piece, because
	 * the model has already handed it over and a stream cannot give it back. That run may not
	 * answer — the gateway has replaced its assignment and refuses anything it sends — so the
	 * piece is kept here for the run that replaced it to report. Without this, a piece the model
	 * produced would be missing from what the reader is shown while still being part of the
	 * finished answer.
	 */
	unreportedText: string;
	/**
	 * The timer that gives up an answer nobody has come back for.
	 *
	 * An answer read in pieces stays open between runs, so it outlives the run that read the
	 * last piece. A task can end without the tab holding the answer ever being told: the gateway
	 * only cancels an assignment, and between two runs there is none. This is what stops such an
	 * answer from keeping a model session open, and the browser generating into it, for as long
	 * as the page stays open.
	 */
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The pieces of the answer received so far, joined. */
	text: string;
	/** How many pieces have been read, which bounds how long one answer may be read for. */
	pieceCount: number;
	/**
	 * Whether {@link StageHelperLlmGemmaNanoChromeFull.clearGeneration} has released this
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
 * How long an answer held open between runs waits for the run that carries it on.
 *
 * The stage's assignment lease is 60 seconds and the gateway assigns the next run as soon as
 * the previous result arrives, so a wait this long means the task is not coming back: it was
 * cancelled while it held no assignment, it ran out of attempts, or its consumer went away.
 * Nothing tells the tab any of that, so the tab decides for itself when to stop waiting.
 */
const ANSWER_IDLE_TIMEOUT_MS = 300_000;

/**
 * Runs the language model built into the browser, in as many stage runs as the consumer asked
 * its answer to arrive in.
 *
 * Nothing is downloaded by the project for this task. The browser holds the model, so the
 * only thing this helper keeps is the open generation: the session and the reader that
 * delivers the answer.
 *
 * The browser produces an answer in pieces, and what one stage run does with those pieces is
 * decided by the `isStreaming` generation setting the consumer submitted:
 *
 * - Asked for nothing, one run reads every piece of the answer and returns the whole thing.
 *   One answer therefore costs one message to the central gateway and one back, however long
 *   it is.
 * - Asked for the answer in pieces, one run reads one piece and returns it, and the generation
 *   stays open in this tab for the run that follows. That costs a message each way per piece,
 *   which is the price of seeing an answer as it is written, and is why it is asked for rather
 *   than always done. No message carries the answer so far, only the piece, so the cost grows
 *   with the length of the answer and not with the square of it.
 *
 * A run that reads a whole answer can last as long as that answer takes. That is safe because
 * the worker browser page sends `stage.heartbeat` for the whole time a stage is running, which
 * moves the assignment lease along ahead of it.
 *
 * The interface used here is the browser's own prompt interface, reached through the global
 * `LanguageModel` object. It is not part of the browser type definitions this project
 * compiles against, so the small part of it that is used is declared above.
 */
export class StageHelperLlmGemmaNanoChromeFull {
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
		return computation === StageHelperLlmGemmaNanoChromeFull.computation;
	}

	/**
	 * The generations this browser is currently producing, by task identifier.
	 *
	 * A generation is kept in a map rather than in a local variable of the run reading it for
	 * two reasons. `clearGeneration` can reach it there, which is how a cancelled task stops the
	 * browser generating an answer nobody will read. And an answer delivered in pieces outlives
	 * the run that read any one piece, so the run that reads the next piece has to find what its
	 * predecessor left.
	 *
	 * The key is the task, because that is what an answer belongs to. Every run of it arrives
	 * under a new assignment identifier, so keying by the assignment would hide each piece of an
	 * answer from the run that has to read the next one. Which run may release a generation is a
	 * separate question, answered by `owningStageAssignmentId` on the state itself.
	 */
	private static stateByTaskId = new Map<string, TaskGenerationState>();

	/**
	 * Reports whether this browser can run the stage, without asking it to download anything.
	 *
	 * This is asked before the browser advertises the stage, so a browser with no built-in
	 * model says so at once instead of accepting work it would fail.
	 *
	 * @returns Whether the stage can be run, and what has to happen first when it cannot yet.
	 */
	static async readiness(): Promise<BuiltInModelReadiness> {
		const factory = StageHelperLlmGemmaNanoChromeFull.factory();
		if (factory === undefined) {
			return {
				status: 'unavailable',
				message: 'This browser has no built-in language model. Chrome 138 or a later version is needed, on a desktop computer that meets its requirements.',
			};
		}
		const availability = await factory.availability();
		if (availability === 'unavailable') {
			if (StageHelperLlmGemmaNanoChromeFull.isDeniedToThisPage()) {
				return {
					status: 'unavailable',
					message: "This page is not allowed to use the browser's built-in language model. A page shown inside a frame from a different address is not allowed to by default, and the page around it has to pass the permission on by setting allow=\"language-model\" on the frame.",
				};
			}
			return {
				status: 'unavailable',
				message: 'This browser has a built-in language model but will not run it on this device. Its storage, memory, or graphics requirements are usually the reason.',
			};
		}
		if (availability === 'available') {
			return {
				status: 'ready',
			};
		}
		return {
			status: 'user_gesture_required',
			message: 'The browser has not downloaded its built-in language model yet, and it only starts that download when the person using the page asks for it.',
		};
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
		const factory = StageHelperLlmGemmaNanoChromeFull.factory();
		if (factory === undefined) {
			return {
				status: 'unavailable',
				message: 'This browser has no built-in language model.',
			};
		}
		const session = await factory.create({
			monitor: (monitor) => monitor.addEventListener('downloadprogress', (event) => onProgress(event.loaded)),
		});
		session.destroy();
		return StageHelperLlmGemmaNanoChromeFull.readiness();
	}

	/**
	 * Reads one answer, either whole or one piece at a time, according to what the consumer
	 * asked for.
	 *
	 * @param taskId The task this run belongs to, which names the answer being produced for it.
	 * @param stageAssignmentId The assignment this run is carrying out, which decides whether this run
	 * is the one allowed to release the answer it is reading.
	 * @param payload The prompt submitted with the task, or, on a run that carries an answer on,
	 * a value saying so and nothing else.
	 * @param generationSettings What the consumer asked for. Only `isStreaming` is read: set, one
	 * run returns one piece and leaves the answer open for the run that follows; absent, one run
	 * returns the whole answer.
	 * @returns One piece of the answer, or the whole answer marked as finished.
	 * @throws If the browser has no built-in language model, if the run is asked to carry on an
	 * answer this browser is not holding, if the answer is abandoned before or while it is being
	 * read, or if the model reports an error.
	 */
	static async compute(
		taskId: string,
		stageAssignmentId: string,
		payload: LlmStagePayload,
		generationSettings: GenerationSettings | undefined,
	): Promise<LlmStagePayload> {
		const wantsPieces = generationSettings?.isStreaming === true;
		const state = payload.isContinuation === true
			? StageHelperLlmGemmaNanoChromeFull.heldGeneration(taskId, stageAssignmentId)
			: StageHelperLlmGemmaNanoChromeFull.newGeneration(taskId, stageAssignmentId);
		// A run that returns a piece leaves the answer open behind it, so it is the one kind of
		// run that must not release what it was reading. Every other way out of this method —
		// the finished answer, and every failure — releases it, and releasing is refused anyway
		// for a run that no longer owns the answer.
		let leavesAnswerOpen = false;
		try {
			const reader = state.reader ?? await StageHelperLlmGemmaNanoChromeFull.startGeneration(state, payload.text ?? '');
			while (state.pieceCount < MAXIMUM_ANSWER_PIECES) {
				const piece = await reader.read();
				if (state.isReleased === true) {
					throw new Error('The answer this stage was producing was abandoned before the model had finished it.');
				}
				if (piece.done === true) {
					break;
				}
				state.text += piece.value;
				state.unreportedText += piece.value;
				state.pieceCount += 1;
				StageHelperLlmGemmaNanoChromeFull.refuseIfReplaced(state, stageAssignmentId);
				if (wantsPieces === true) {
					leavesAnswerOpen = true;
					const reported = state.unreportedText;
					state.unreportedText = '';
					StageHelperLlmGemmaNanoChromeFull.waitForTheRunAfterThis(taskId, state);
					return StagePayloadFactory.llmPartialText(reported);
				}
			}
			StageHelperLlmGemmaNanoChromeFull.refuseIfReplaced(state, stageAssignmentId);
			// The whole answer travels on this one result, whichever way it was read. A consumer
			// that has been joining the pieces has already received every one of them, so this
			// result adds no piece of its own and is instead what that consumer can check its own
			// joining against.
			//
			// Milestone 0's de-risk gate for https://github.com/webai-at-home/webai-at-home/issues/150
			// found this engine reports no prompt or completion token count at all, only a single
			// cumulative context-window usage number in its own unit, not tokens — so `usage` carries
			// only `stopReason`, never a token count nobody reported. And it can only ever be
			// `end_of_sequence` here: this engine found no cap-driven cutoff to distinguish, and a
			// session destroyed mid-read (`release`, on task cancellation) throws out of the
			// `reader.read()` above rather than letting this line run, so an interrupted answer never
			// reaches this return at all.
			return StagePayloadFactory.llmDone(state.text, undefined, { stopReason: 'end_of_sequence' });
		} finally {
			if (leavesAnswerOpen === false) {
				StageHelperLlmGemmaNanoChromeFull.clearGeneration(taskId, stageAssignmentId);
			}
		}
	}

	/**
	 * Releases every answer this browser is holding.
	 *
	 * Called when the connection to the gateway goes away. An answer held open between runs is
	 * carried on by the run that follows, and no run can follow while there is no connection to
	 * assign one. Whatever the gateway does with the task from here, it will not be this
	 * connection that carries it on, so nothing is lost by stopping the model now, and a model
	 * session left running would be held for as long as the page stays open.
	 */
	static clearEveryGeneration(): void {
		for (const [taskId, state] of StageHelperLlmGemmaNanoChromeFull.stateByTaskId) {
			StageHelperLlmGemmaNanoChromeFull.stateByTaskId.delete(taskId);
			StageHelperLlmGemmaNanoChromeFull.release(state);
		}
	}

	/**
	 * Releases the answer this browser is producing for one task, if the assignment named is the
	 * one currently reading it.
	 *
	 * Called once an answer is finished, and also when a stage fails or its assignment is taken
	 * away, so an abandoned answer does not leave a model session open and does not leave the
	 * browser generating text nobody will read.
	 *
	 * A run that has been replaced calls this too, after its replacement has already taken the
	 * answer over. Checking which assignment holds the answer is what stops the replaced run
	 * from destroying the session its replacement is reading from.
	 *
	 * @param taskId The task whose answer should be released.
	 * @param stageAssignmentId The assignment asking to release it.
	 */
	static clearGeneration(taskId: string, stageAssignmentId: string): void {
		const state = StageHelperLlmGemmaNanoChromeFull.stateByTaskId.get(taskId);
		if (state === undefined || state.owningStageAssignmentId !== stageAssignmentId) {
			return;
		}
		StageHelperLlmGemmaNanoChromeFull.stateByTaskId.delete(taskId);
		StageHelperLlmGemmaNanoChromeFull.release(state);
	}

	/**
	 * Registers a new answer for a task, replacing anything this browser still held for it.
	 *
	 * The state is registered before the session it will hold is asked for, so that an
	 * assignment taken away during that wait has something to mark released.
	 *
	 * @param taskId The task the answer belongs to.
	 * @param stageAssignmentId The assignment whose run is starting the answer.
	 * @returns The state that run reads its answer into.
	 */
	private static newGeneration(taskId: string, stageAssignmentId: string): TaskGenerationState {
		// A task asks for its answer once, so anything still held for this task is left over from
		// an attempt that was given up on without being cancelled. Releasing it here is what stops
		// a retried task from leaving a model session open for the answer it abandoned.
		const abandoned = StageHelperLlmGemmaNanoChromeFull.stateByTaskId.get(taskId);
		if (abandoned !== undefined) {
			StageHelperLlmGemmaNanoChromeFull.release(abandoned);
		}
		const state: TaskGenerationState = {
			session: undefined,
			reader: undefined,
			owningStageAssignmentId: stageAssignmentId,
			unreportedText: '',
			idleTimer: undefined,
			text: '',
			pieceCount: 0,
			isReleased: false,
		};
		StageHelperLlmGemmaNanoChromeFull.stateByTaskId.set(taskId, state);
		return state;
	}

	/**
	 * Finds the answer this browser is holding open for a task, so this run can read on from it.
	 *
	 * @param taskId The task whose answer is being carried on.
	 * @param stageAssignmentId The assignment whose run is carrying it on, which becomes the one
	 * allowed to release the answer.
	 * @returns The state holding the answer so far.
	 * @throws If this browser holds no answer for the task.
	 */
	private static heldGeneration(taskId: string, stageAssignmentId: string): TaskGenerationState {
		const state = StageHelperLlmGemmaNanoChromeFull.stateByTaskId.get(taskId);
		// The answer lives in the memory of the tab producing it and nowhere else, so a run asked
		// to carry on an answer this tab is not holding cannot produce one. Starting a fresh
		// answer instead would answer a prompt this run was not given, since a run that carries an
		// answer on is sent no prompt.
		if (state === undefined) {
			throw new Error('This stage was asked to carry on an answer, but this browser is not holding one for that task.');
		}
		// The run that carries the answer on has arrived, so the answer is no longer waiting for
		// one, and this run is now the one allowed to release it.
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = undefined;
		state.owningStageAssignmentId = stageAssignmentId;
		return state;
	}

	/**
	 * Stops a run that has been replaced from answering for an assignment it no longer holds.
	 *
	 * The gateway refuses anything sent for a replaced assignment, so such a run has nothing to
	 * gain by carrying on and would take pieces from the model that its replacement needs. What
	 * it has already read stays in `unreportedText`, where its replacement reports it.
	 *
	 * @param state The answer this run was reading.
	 * @param stageAssignmentId The assignment this run is carrying out.
	 * @throws If another run has taken the answer over.
	 */
	private static refuseIfReplaced(state: TaskGenerationState, stageAssignmentId: string): void {
		if (state.owningStageAssignmentId === stageAssignmentId) {
			return;
		}
		throw new Error('This run was replaced by a later one while it was waiting for the model, so its answer belongs to that run.');
	}

	/**
	 * Starts the wait for the run that carries this answer on, giving the answer up if none comes.
	 *
	 * @param taskId The task whose answer is being held open.
	 * @param state The answer being held open.
	 */
	private static waitForTheRunAfterThis(taskId: string, state: TaskGenerationState): void {
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = setTimeout(() => {
			// Read from the map rather than closing over the decision: by now this answer may have
			// been released and a different one started for the same task.
			if (StageHelperLlmGemmaNanoChromeFull.stateByTaskId.get(taskId) !== state) {
				return;
			}
			StageHelperLlmGemmaNanoChromeFull.stateByTaskId.delete(taskId);
			StageHelperLlmGemmaNanoChromeFull.release(state);
		}, ANSWER_IDLE_TIMEOUT_MS);
	}

	/**
	 * Ends one answer: stops the model producing it and gives back what the browser holds for it.
	 *
	 * @param state The answer to release.
	 */
	private static release(state: TaskGenerationState): void {
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = undefined;
		// Set before either of the two below, because both are how a run that is waiting learns
		// it has been released, and because neither exists yet when the release arrives while
		// the session is still being created. In that case this flag is the only signal, and
		// `startGeneration` is where it is read.
		state.isReleased = true;
		if (state.reader !== undefined) {
			void state.reader.cancel().catch(() => undefined);
		}
		if (state.session !== undefined) {
			state.session.destroy();
		}
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
	private static async startGeneration(
		state: TaskGenerationState,
		prompt: string,
	): Promise<ReadableStreamDefaultReader<string>> {
		if (prompt.trim() === '') {
			throw new Error('A prompt is needed to start an answer.');
		}
		const factory = StageHelperLlmGemmaNanoChromeFull.factory();
		if (factory === undefined) {
			throw new Error('This browser has no built-in language model.');
		}
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
		if (featurePolicy === undefined) {
			return false;
		}
		return featurePolicy.allowsFeature('language-model') === false;
	}
}
