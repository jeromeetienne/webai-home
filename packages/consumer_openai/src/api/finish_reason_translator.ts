// local imports
import { OpenaiError } from './openai_error.js';
import type { ChatCompletionFinishReason } from './openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	FinishReasonTranslator — turns a worker's own stop reason into an OpenAI value
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Translates `LlmStagePayload.stopReason`, the worker's own word for why generation stopped,
 * into the OpenAI value `finish_reason` carries, under Rule 2 of this project's OpenAI
 * compatibility requirement from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
 */
export class FinishReasonTranslator {
	/**
	 * Translates one stop reason.
	 *
	 * `undefined` translates to `stop` rather than being refused, because most workers do not
	 * report a stop reason yet — milestone 3 of issue #150 adds that reporting one worker at a
	 * time — and an answer from such a worker is not wrong, it is simply not described. `stop`
	 * is what this server reported for every answer before this milestone, so an unreported
	 * reason keeps behaving exactly as it always has.
	 *
	 * @param stopReason The worker's own word for why generation stopped, or `undefined` when the
	 * worker did not report one.
	 * @returns The OpenAI value to answer with.
	 * @throws OpenaiError when the stop reason is `interrupted`, since there is no OpenAI value
	 * for an answer the cluster gave up on producing.
	 */
	static translate(stopReason: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' | undefined): ChatCompletionFinishReason {
		if (stopReason === undefined || stopReason === 'end_of_sequence') {
			return 'stop';
		}
		if (stopReason === 'max_new_tokens') {
			return 'length';
		}
		throw OpenaiError.taskFailed('the cluster stopped generating this answer before it finished, and there is no OpenAI value for that');
	}
}
