import { StageName, type StageName as StageNameType } from '@webai/protocol';
import { StageDevFormulaHelper } from '../stages/stage_dev_formula_helper';
import { StageLlmQwen3_0_6bHelper } from '../stages/stage_llm_qwen3_0_6b_helper';
import { StageLlmGemmaNanoChromeHelper } from '../stages/stage_llm_gemma_nano_chrome_helper';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerStageOffer — decides which stages this browser offers the central gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Works out which of the gateway's pipeline stages this browser is willing to run.
 *
 * The decision is made against the computation a stage names, never against the stage name
 * itself, so a pipeline the gateway loaded after this browser was built can offer new stage
 * names that reuse computations already shipped here.
 */
export class WorkerStageOffer {
	/**
	 * Reads the stages the page URL restricts this worker browser to.
	 *
	 * Repeating the parameter allows one worker browser to support multiple stages. The
	 * stageNames alias keeps existing debug URLs working.
	 *
	 * @param search The page URL's query string.
	 * @returns The named stages, without repeats. An empty result means the URL asks for no
	 * particular stages, and this browser offers every stage it can run.
	 */
	static requestedStageNamesFromUrl(search: string): StageNameType[] {
		const searchParams = new URLSearchParams(search);
		const requestedStageNames = [
			...searchParams.getAll('enabledStages'),
			...searchParams.getAll('stageNames'),
		];
		const validStageNames = requestedStageNames.filter((stageName): stageName is StageNameType =>
			StageName.safeParse(stageName).success,
		);
		return [...new Set(validStageNames)];
	}

	/**
	 * Chooses the stages this browser offers to the gateway, from the pipelines the gateway has
	 * loaded.
	 *
	 * A stage is offered when this browser implements its computation and, if the page URL named
	 * particular stages, when the stage is one of those.
	 *
	 * @param pipelines The pipeline specifications the gateway returned.
	 * @param requestedStageNames The stages the page URL restricts this browser to, if any.
	 * @returns The stage names to advertise, the language-model shard positions to preload, and
	 * the offered stages that need the language model built into the browser.
	 */
	static offeredStages(
		pipelines: { stages: { name: string; computation: string }[] }[],
		requestedStageNames: readonly string[],
	): { stageNames: string[]; llmShardIndexes: number[]; builtInModelStageNames: string[] } {
		const stageNames: string[] = [];
		const llmShardIndexes: number[] = [];
		const builtInModelStageNames: string[] = [];
		for (const pipeline of pipelines) {
			for (const [stageIndex, stage] of pipeline.stages.entries()) {
				if (WorkerStageOffer.implementsComputation(stage.computation) === false) {
					continue;
				}
				if (requestedStageNames.length > 0 && requestedStageNames.includes(stage.name) === false) {
					continue;
				}
				if (stageNames.includes(stage.name) === false) {
					stageNames.push(stage.name);
				}
				if (
					StageLlmQwen3_0_6bHelper.implementsComputation(stage.computation)
					&& llmShardIndexes.includes(stageIndex) === false
				) {
					llmShardIndexes.push(stageIndex);
				}
				if (
					StageLlmGemmaNanoChromeHelper.implementsComputation(stage.computation)
					&& builtInModelStageNames.includes(stage.name) === false
				) {
					builtInModelStageNames.push(stage.name);
				}
			}
		}
		return { stageNames, llmShardIndexes, builtInModelStageNames };
	}

	/**
	 * Reports whether this browser implements the computation a pipeline stage names.
	 *
	 * This is the only place the browser decides what it can run.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when one of this browser's helpers implements it.
	 */
	private static implementsComputation(computation: string): boolean {
		return StageDevFormulaHelper.implementsComputation(computation)
			|| StageLlmQwen3_0_6bHelper.implementsComputation(computation)
			|| StageLlmGemmaNanoChromeHelper.implementsComputation(computation);
	}
}
