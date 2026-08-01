import type { GenerationSettings, LlmStagePayload } from '@webai/protocol';
import type { OpenaiApiClient } from '../libs/openai_api_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageHelperLlmLlama3_2_3bFull — runs Llama 3.2 3B through a local OpenAI-compatible server
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Whether this worker can run the stage, and why not when it cannot. */
export type LocalModelReadiness =
	| { status: 'ready' }
	| { status: 'unavailable'; message: string };

/**
 * Runs the complete Llama 3.2 3B model by forwarding the stage's prompt to a locally running
 * server that speaks the OpenAI-compatible Chat Completions API, such as Ollama or LM Studio.
 *
 * The model is held complete on one device by that server, which also loads it, quantizes it,
 * and drives the hardware, so this helper only has to send a prompt and read the answer back.
 * Which server it talks to, and which model that server is asked for, are options of the worker
 * process rather than decisions this project makes, which is why the task type names the model
 * and not the server (see https://github.com/webai-at-home/webai-at-home/issues/103).
 *
 * This file holds the readiness check today. The Chat Completions call that produces an answer,
 * and the answer held open between stage runs when the consumer asked for its answer in pieces,
 * are added in step 3 of that same issue.
 */
export class StageHelperLlmLlama3_2_3bFull {
	/**
	 * The computation this worker implements, named the way a pipeline stage names its
	 * computation.
	 */
	static readonly computation = 'llm_llama3_2_3b_full';

	/**
	 * Reports whether this helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return computation === StageHelperLlmLlama3_2_3bFull.computation;
	}

	/**
	 * Reports whether this worker can run the stage, before it advertises it.
	 *
	 * A worker that cannot reach its configured server, or whose server does not offer the model
	 * it was told to serve, says so at once instead of accepting work it would fail. This is the
	 * native equivalent of the WebGPU and storage checks a worker browser page runs before it
	 * offers a stage that downloads a model.
	 *
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model this worker was told to serve, such as `llama3.2:3b`.
	 * @returns Whether the stage can be run, and why not when it cannot.
	 */
	static async readiness(openaiApiClient: OpenaiApiClient, modelId: string): Promise<LocalModelReadiness> {
		let modelIds: string[];
		try {
			modelIds = await openaiApiClient.listModelIds();
		} catch (error: unknown) {
			return {
				status: 'unavailable',
				message: error instanceof Error ? error.message : String(error),
			};
		}
		if (modelIds.includes(modelId) === false) {
			return {
				status: 'unavailable',
				message: `The local server does not offer ${modelId}. The models it offers are: ${modelIds.length === 0 ? 'none' : modelIds.join(', ')}.`,
			};
		}
		return { status: 'ready' };
	}

	/**
	 * Answers one run of the stage.
	 *
	 * @param taskId The task this run belongs to, which names the answer being produced for it.
	 * @param assignmentId The assignment this run is carrying out.
	 * @param payload The prompt submitted with the task, or, on a run that carries an answer on,
	 * a value saying so and nothing else.
	 * @param generationSettings What the consumer asked for about how its answer is generated.
	 * @returns One piece of the answer, or the whole answer marked as finished.
	 * @throws Always, until step 3 of https://github.com/webai-at-home/webai-at-home/issues/103
	 * implements it.
	 */
	static async compute(
		taskId: string,
		assignmentId: string,
		payload: LlmStagePayload,
		generationSettings: GenerationSettings | undefined,
	): Promise<LlmStagePayload> {
		void taskId;
		void assignmentId;
		void payload;
		void generationSettings;
		throw new Error('Generating an answer is not implemented yet. Step 3 of https://github.com/webai-at-home/webai-at-home/issues/103 adds the call to the Chat Completions endpoint.');
	}
}
