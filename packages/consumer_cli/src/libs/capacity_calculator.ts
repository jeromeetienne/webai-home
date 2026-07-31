import type { Device, PipelineSpecification } from '@webai/protocol';
import { DeviceAvailability } from './device_availability.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CapacityCalculator — how many concurrent runs of a pipeline the cluster can support
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How many concurrent runs of one pipeline the connected workers can currently support. */
export type CapacityResult = {
	/** How many concurrent runs the cluster can currently support. */
	capacity: number;
	/** A one-line, human-readable statement of what is limiting that number. */
	reason: string;
};

/** How available one stage's advertising workers currently are, added up. */
type StageCapacity = {
	stageName: string;
	capacity: number;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Capacity Calculator
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Estimates how many concurrent runs of a pipeline the currently connected workers can
 * support, from the pipeline's own specification and the live device list.
 *
 * The formula depends on how the pipeline was built. A pipeline whose every stage sets
 * `prefersSameWorkerOnRetry` keeps state in one worker's memory across its whole run — a
 * language-model shard's key-value cache, for instance — so only a worker advertising every
 * one of its stages can host a run at all, and the cluster's capacity is the total free
 * capacity of those workers. A pipeline with no such stage can spread one run's stages across
 * different workers, so its capacity is set by whichever stage has the least free capacity
 * behind it.
 */
export class CapacityCalculator {
	/**
	 * @param pipeline The pipeline specification to estimate capacity for.
	 * @param devices The currently connected devices, worker and consumer alike.
	 * @returns The estimated concurrent-run capacity, with a one-line reason.
	 */
	static calculate(pipeline: PipelineSpecification, devices: Device[]): CapacityResult {
		const workers = devices.filter((device) => device.deviceRole === 'worker');
		const isWorkerPinned = pipeline.stages.every((stage) => stage.prefersSameWorkerOnRetry === true);
		return isWorkerPinned
			? CapacityCalculator._workerPinnedCapacity(pipeline, workers)
			: CapacityCalculator._independentStageCapacity(pipeline, workers);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Formulas
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * The worker-pinned formula: only a worker advertising every stage of the pipeline can
	 * host a run, so capacity is the total free capacity of those workers.
	 *
	 * @param pipeline The pipeline to estimate capacity for.
	 * @param workers The currently connected worker devices.
	 * @returns The estimated concurrent-run capacity, with a one-line reason.
	 */
	private static _workerPinnedCapacity(pipeline: PipelineSpecification, workers: Device[]): CapacityResult {
		const stageNames = pipeline.stages.map((stage) => stage.name);
		const coveringWorkers = workers.filter((worker) => stageNames.every((stageName) => worker.stageNames.includes(stageName)));
		const capacity = coveringWorkers.reduce((sum, worker) => sum + DeviceAvailability.availableCapacity(worker), 0);
		const stageWord = stageNames.length === 1 ? 'stage' : 'stages';
		return {
			capacity,
			reason: `worker coverage (${coveringWorkers.length} of ${workers.length} workers advertise all ${stageNames.length} ${stageWord})`,
		};
	}

	/**
	 * The independent-stage formula: each stage can run on a different worker, so capacity is
	 * set by whichever stage has the least free capacity behind it.
	 *
	 * @param pipeline The pipeline to estimate capacity for.
	 * @param workers The currently connected worker devices.
	 * @returns The estimated concurrent-run capacity, with a one-line reason.
	 */
	private static _independentStageCapacity(pipeline: PipelineSpecification, workers: Device[]): CapacityResult {
		const stageCapacities: StageCapacity[] = pipeline.stages.map((stage) => ({
			stageName: stage.name,
			capacity: workers
				.filter((worker) => worker.stageNames.includes(stage.name))
				.reduce((sum, worker) => sum + DeviceAvailability.availableCapacity(worker), 0),
		}));
		const bottleneck = stageCapacities.reduce((lowest, current) => (current.capacity < lowest.capacity ? current : lowest));
		const others = stageCapacities.filter((stageCapacity) => stageCapacity !== bottleneck);
		if (others.length === 0) {
			return { capacity: bottleneck.capacity, reason: `${bottleneck.stageName} (${bottleneck.capacity} available slot${bottleneck.capacity === 1 ? '' : 's'})` };
		}
		const highestOther = others.reduce((highest, current) => (current.capacity > highest.capacity ? current : highest));
		return {
			capacity: bottleneck.capacity,
			reason: `${bottleneck.stageName} (${bottleneck.capacity} available slot${bottleneck.capacity === 1 ? '' : 's'} vs ${highestOther.capacity} on ${highestOther.stageName})`,
		};
	}
}
