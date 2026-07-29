import type { StageName, Task } from "@webai/protocol";
import type { PipelineRegistry } from "./pipeline_registry.js";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StagePolicyResolver — decides the lease and the retry placement for one stage
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How one stage's assignment is leased, and where a retry of that stage should go. */
export type StagePolicy = {
	/** How long the assignment lease lasts, in milliseconds. */
	leaseMs: number;
	/**
	 * Whether a retry should go back to the worker that previously held the stage, rather
	 * than deliberately avoiding that worker.
	 */
	prefersSameWorkerOnRetry: boolean;
};

/**
 * The stages of the built-in language-model pipeline.
 *
 * These stages are not described by a pipeline specification, because the specification
 * format lists each stage once and the language-model pipeline instead cycles through its
 * three shards once per generated token. Their settings therefore live here.
 */
const builtinLlmStageNames: StageName[] = ["stage_llm_shard1", "stage_llm_shard2", "stage_llm_shard3"];

/**
 * Resolves the lease duration and the retry placement for one stage of one task.
 *
 * A task created from a pipeline specification takes the settings its specification states.
 * Every other task falls back to the built-in settings for the stage name, and finally to
 * the gateway's `--lease-ms` default.
 */
export class StagePolicyResolver {
	/**
	 * @param pipelineRegistry The registry holding the validated pipeline specifications.
	 * @param defaultLeaseMs The gateway's `--lease-ms` value, used by any stage that states
	 * no lease of its own.
	 */
	constructor(private readonly pipelineRegistry: PipelineRegistry, private readonly defaultLeaseMs: number) {}

	/**
	 * Resolves the settings for one stage of one task.
	 *
	 * @param task The task the stage belongs to.
	 * @param stageName The stage being assigned or retried.
	 * @returns The lease duration and the retry placement for that stage.
	 */
	resolve(task: Task, stageName: StageName): StagePolicy {
		const specified = this._specifiedStage(task, stageName);
		if (specified !== undefined) {
			return {
				leaseMs: specified.leaseMs ?? this.defaultLeaseMs,
				prefersSameWorkerOnRetry: specified.prefersSameWorkerOnRetry ?? StagePolicyResolver._isBuiltinAffinityStage(stageName),
			};
		}
		return { leaseMs: this.defaultLeaseMs, prefersSameWorkerOnRetry: StagePolicyResolver._isBuiltinAffinityStage(stageName) };
	}

	/**
	 * Reports whether a stage keeps state between assignments even without a pipeline
	 * specification saying so.
	 *
	 * The language-model shards do: all shards of one task stay on one device so the worker
	 * can retain its in-memory key-value cache between generation rounds. Moving a retry to a
	 * different device throws that cache away, at exactly the moment the model is slow.
	 *
	 * @param stageName The stage to classify.
	 * @returns `true` when a retry of the stage should prefer the previous worker.
	 */
	private static _isBuiltinAffinityStage(stageName: StageName): boolean {
		return builtinLlmStageNames.includes(stageName);
	}

	/**
	 * Finds the stage entry a task's pipeline specification states for one stage.
	 *
	 * @param task The task whose pipeline specification is consulted.
	 * @param stageName The stage to look up.
	 * @returns The stage entry, or `undefined` when the task has no pipeline specification
	 * or the specification does not list the stage.
	 */
	private _specifiedStage(task: Task, stageName: StageName) {
		if (task.pipelineId === undefined || task.pipelineVersion === undefined) return undefined;
		const specification = this.pipelineRegistry.get(task.pipelineId, task.pipelineVersion);
		return specification?.stages.find((stage) => stage.name === stageName);
	}
}
