import type { PipelineStage, StageName, Task } from "@webai/protocol";
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
 * Resolves the lease duration and the retry placement for one stage of one task.
 *
 * The settings come from the task's own pipeline specification. A stage that states neither
 * setting keeps its assignment for the gateway's `--lease-ms` default and is retried away
 * from the worker that lost it. No stage name appears in this file, so a pipeline added
 * through `--pipeline-file` is treated exactly like a built-in one.
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
		const specified = this.stageSpecification(task, stageName);
		return {
			leaseMs: specified?.leaseMs ?? this.defaultLeaseMs,
			prefersSameWorkerOnRetry: specified?.prefersSameWorkerOnRetry ?? false,
		};
	}

	/**
	 * Finds the entry a task's pipeline specification states for one stage.
	 *
	 * @param task The task whose pipeline specification is consulted.
	 * @param stageName The stage to look up.
	 * @returns The stage entry, or `undefined` when the task has no pipeline specification
	 * or the specification does not list the stage.
	 */
	stageSpecification(task: Task, stageName: StageName): PipelineStage | undefined {
		if (task.pipelineId === undefined || task.pipelineVersion === undefined) return undefined;
		const specification = this.pipelineRegistry.get(task.pipelineId, task.pipelineVersion);
		return specification?.stages.find((stage) => stage.name === stageName);
	}
}
