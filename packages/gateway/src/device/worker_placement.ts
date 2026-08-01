import type { Device, StageName, Task } from '@webai/protocol';
import type { DeviceRegistry } from './device_registry.js';
import type { StagePolicy } from '../task/stage_policy_resolver.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerPlacement — decides which device a stage that keeps state must run on
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Whether the assignment the previous worker held has already been released before the
 * placement decision is made.
 *
 * The two cases differ in what the worker's assignment counter currently says. When a lease
 * expires, the worker still holds the assignment that is about to be replaced, so that one
 * assignment has to be discounted before the counter is compared against the worker's own
 * limit. When a stage result arrives, the gateway has already released the assignment, so
 * the counter is already correct and discounting anything would let the worker take one
 * assignment more than its limit allows.
 */
export type AssignmentReleaseState = {
	/** `true` when the previous assignment has already been released from the worker. */
	isPreviousAssignmentReleased: boolean;
};

/**
 * Decides which worker device a stage should be placed on when that stage keeps state in the
 * memory of the device running it.
 *
 * No stage name and no task type appear in this file. Whether a stage keeps state is stated
 * by the stage's own pipeline specification, through `prefersSameWorkerOnRetry`, and reaches
 * this class as a resolved stage policy.
 */
export class WorkerPlacement {
	/**
	 * Returns the worker device an upcoming stage should be placed on before any other device
	 * is considered.
	 *
	 * The device that holds the state an upcoming stage needs depends on which stage is
	 * upcoming, not on which device ran last. In a pipeline that repeats, the device holding
	 * the state for the upcoming stage is the device that ran that same stage in the previous
	 * round, which is why the task's own record of per-stage placement is consulted first. The
	 * device that just finished a stage is the fallback, for the first round of a repeating
	 * pipeline and for a pipeline whose state is handed from one stage to the next on the same
	 * device.
	 *
	 * @param task - The task whose next stage is being placed.
	 * @param upcomingStage - The stage about to be assigned.
	 * @param policy - The resolved policy for the upcoming stage.
	 * @param previousWorkerDeviceId - The device that just finished a stage of this task. Leave
	 * it out for a task that is waiting in the queue rather than continuing from a result just
	 * received, where no device has just finished anything.
	 * @returns The device to place the stage on before considering any other, or `undefined`
	 * when the stage keeps no state and so may run anywhere, or when no device is known to
	 * hold state for it.
	 */
	static preferredWorkerDeviceId(task: Task, upcomingStage: StageName, policy: StagePolicy, previousWorkerDeviceId?: string): string | undefined {
		if (policy.prefersSameWorkerOnRetry === false) return undefined;
		return task.stageWorkerDeviceIds?.[upcomingStage] ?? previousWorkerDeviceId;
	}

	/**
	 * Reports whether a named worker can be given a stage again.
	 *
	 * Every condition is the one `DeviceRegistry.findWorker` applies, except that the worker is
	 * named rather than searched for, and that its assignment counter is read according to
	 * whether the previous assignment has already been released.
	 *
	 * @param deviceRegistry - The registry holding the connected devices.
	 * @param workerDeviceId - The worker that should take the stage.
	 * @param stage - The stage being placed.
	 * @param releaseState - Whether the previous assignment has already been released.
	 * @returns The worker device when it can take the stage, or `undefined`.
	 */
	static reusableWorker(deviceRegistry: DeviceRegistry, workerDeviceId: string, stage: StageName, releaseState: AssignmentReleaseState): Device | undefined {
		const device = deviceRegistry.get(workerDeviceId);
		if (device === undefined || device.deviceRole !== 'worker') return undefined;
		if (device.workerState === 'draining' || device.ready === false) return undefined;
		if (device.stageNames.includes(stage) === false) return undefined;
		const activeAssignments = releaseState.isPreviousAssignmentReleased
			? (device.activeAssignments ?? 0)
			: Math.max(0, (device.activeAssignments ?? 0) - 1);
		if (activeAssignments >= (device.maxConcurrentAssignments ?? 1)) return undefined;
		return device;
	}
}
