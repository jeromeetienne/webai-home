import { StagePayloadFactory, type LlmStagePayload } from "@webai/protocol";

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
type BuiltInModelAvailability = "unavailable" | "downloadable" | "downloading" | "available";

/** One generation held open by the browser's built-in language model. */
interface BuiltInModelSession {
	/** Asks for an answer and returns it in pieces as they are produced. */
	promptStreaming(prompt: string): ReadableStream<string>;
	/** Releases the session and the memory the browser holds for it. */
	destroy(): void;
}

/**
 * How a download of the built-in model reports its progress.
 *
 * The browser passes an event target, but only this one event is used here, so only this one
 * way of listening for it is declared.
 */
interface BuiltInModelDownloadMonitor {
	addEventListener(type: "downloadprogress", listener: (event: { loaded: number }) => void): void;
}

/** The browser object that reports on, and creates sessions with, the built-in language model. */
interface BuiltInModelFactory {
	availability(): Promise<BuiltInModelAvailability>;
	create(options?: { monitor?: (monitor: BuiltInModelDownloadMonitor) => void }): Promise<BuiltInModelSession>;
}

/**
 * Whether this browser can run the stage, and what has to happen first when it cannot yet.
 *
 * `user_gesture_required` is not a failure. The browser has the model on offer but will only
 * start the download from a button the person using the page presses themselves, so the page
 * has to ask for that press before this browser can offer the stage.
 */
export type BuiltInModelReadiness =
	| { status: "ready" }
	| { status: "user_gesture_required"; message: string }
	| { status: "unavailable"; message: string };

/** One answer this browser is producing, kept in memory for as long as its task runs here. */
interface TaskGenerationState {
	/** The session the answer is being generated in. */
	session: BuiltInModelSession;
	/** The reader that delivers the answer one piece at a time. */
	reader: ReadableStreamDefaultReader<string>;
	/** The pieces of the answer received so far, joined. */
	text: string;
	/** How many pieces have been read, which bounds how many times the stage may repeat. */
	pieceCount: number;
}

/**
 * The largest number of pieces one answer may be read in.
 *
 * Each piece costs one stage assignment, so a model that never finished an answer would
 * otherwise keep one task running for as long as the page is open. This is the same kind of
 * bound as the generated-token limit of the sharded Qwen3 task.
 */
const MAXIMUM_ANSWER_PIECES = 400;

/**
 * Runs the language model built into the browser, one piece of the answer per stage run.
 *
 * Nothing is downloaded by the project for this task. The browser holds the model, so the
 * only thing this helper keeps is the open generation: the session and the reader that
 * delivers the answer. Both live in this module's memory, keyed by task identifier, in the
 * same way that the sharded Qwen3 helper keeps a key-value cache. That is what the stage's
 * `prefersSameWorkerOnRetry` setting protects, and why the pipeline repeats its single stage
 * instead of asking a fresh device for the rest of an answer it cannot see.
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
	static readonly computation = "llm_gemma_nano_chrome_full";

	/**
	 * Reports whether this helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return computation === StageLlmGemmaNanoChromeHelper.computation;
	}

	/** The generations this browser is currently producing, by task identifier. */
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
		const factory = StageLlmGemmaNanoChromeHelper.factory();
		if (factory === undefined) return { status: "unavailable", message: "This browser has no built-in language model. Chrome 138 or a later version is needed, on a desktop computer that meets its requirements." };
		const availability = await factory.availability();
		if (availability === "unavailable") {
			if (StageLlmGemmaNanoChromeHelper.isDeniedToThisPage()) return { status: "unavailable", message: "This page is not allowed to use the browser's built-in language model. A page shown inside a frame from a different address is not allowed to by default, and the page around it has to pass the permission on by setting allow=\"language-model\" on the frame." };
			return { status: "unavailable", message: "This browser has a built-in language model but will not run it on this device. Its storage, memory, or graphics requirements are usually the reason." };
		}
		if (availability === "available") return { status: "ready" };
		return { status: "user_gesture_required", message: "The browser has not downloaded its built-in language model yet, and it only starts that download when the person using the page asks for it." };
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
		if (factory === undefined) return { status: "unavailable", message: "This browser has no built-in language model." };
		const session = await factory.create({
			monitor: (monitor) => monitor.addEventListener("downloadprogress", (event) => onProgress(event.loaded)),
		});
		session.destroy();
		return StageLlmGemmaNanoChromeHelper.readiness();
	}

	/**
	 * Reads the next piece of one task's answer, starting the answer on the first run.
	 *
	 * @param taskId The task this stage belongs to, used to find the generation held for it.
	 * @param payload The prompt on the first run of a task, or the answer so far on a later run.
	 * @returns The answer so far, marked as finished once the model has stopped producing it.
	 * @throws If the browser has no built-in language model, if a continuation arrives for a
	 * task this browser holds no generation for, or if the model reports an error.
	 */
	static async compute(taskId: string, payload: LlmStagePayload): Promise<LlmStagePayload> {
		const state = payload.isContinuation === true
			? StageLlmGemmaNanoChromeHelper.stateByTaskId.get(taskId)
			: await StageLlmGemmaNanoChromeHelper.startTask(taskId, payload.text ?? "");
		if (state === undefined) throw new Error("This browser is not holding the answer this stage continues, so the rest of it cannot be read here.");

		const piece = await state.reader.read();
		if (piece.done === true) {
			StageLlmGemmaNanoChromeHelper.clearTask(taskId);
			return StagePayloadFactory.llmDone(state.text);
		}
		state.text += piece.value;
		state.pieceCount += 1;
		if (state.pieceCount >= MAXIMUM_ANSWER_PIECES) {
			StageLlmGemmaNanoChromeHelper.clearTask(taskId);
			return StagePayloadFactory.llmDone(state.text);
		}
		return StagePayloadFactory.llmPartialText(state.text);
	}

	/**
	 * Releases the generation this browser holds for a task.
	 *
	 * Called once an answer is finished, and also when a stage fails or its assignment is
	 * taken away, so an abandoned task does not leave a model session open.
	 *
	 * @param taskId The task whose generation should be released.
	 */
	static clearTask(taskId: string): void {
		const state = StageLlmGemmaNanoChromeHelper.stateByTaskId.get(taskId);
		if (state === undefined) return;
		StageLlmGemmaNanoChromeHelper.stateByTaskId.delete(taskId);
		void state.reader.cancel().catch(() => undefined);
		state.session.destroy();
	}

	/**
	 * Starts one answer and keeps its session and reader for the rest of the task.
	 *
	 * Asking for the answer does not wait for it. The model returns a stream at once and
	 * produces the answer into it, so the first piece is read by the caller in the same way
	 * as every later piece.
	 *
	 * @param taskId The task the answer belongs to.
	 * @param prompt The prompt submitted with the task.
	 * @returns The generation state now held for the task.
	 * @throws If the prompt is empty or this browser has no built-in language model.
	 */
	private static async startTask(taskId: string, prompt: string): Promise<TaskGenerationState> {
		if (prompt.trim() === "") throw new Error("A prompt is needed to start an answer.");
		StageLlmGemmaNanoChromeHelper.clearTask(taskId);
		const factory = StageLlmGemmaNanoChromeHelper.factory();
		if (factory === undefined) throw new Error("This browser has no built-in language model.");
		const session = await factory.create();
		const state: TaskGenerationState = {
			session,
			reader: session.promptStreaming(prompt).getReader(),
			text: "",
			pieceCount: 0,
		};
		StageLlmGemmaNanoChromeHelper.stateByTaskId.set(taskId, state);
		return state;
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
		return featurePolicy.allowsFeature("language-model") === false;
	}
}
