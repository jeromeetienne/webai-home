import { StagePayloadFactory, type StageName, type StagePayload } from '@webai/protocol';
import { TaskProjection } from '@webai/protocol/task_projection';
import type { ConnectionHub } from './connection_hub.js';
import type { DeviceAnnouncer } from './device_announcer.js';
import type { DeviceRegistry } from './device_registry.js';
import type { StagePolicyResolver } from './stage_policy_resolver.js';
import { TaskStore } from './task_store.js';
import { WorkerPlacement } from './worker_placement.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TaskScheduler — places task stages on workers, retries them, and reports task progress
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How one call to `assign` differs from placing a stage on any free worker. */
export type AssignOptions = {
	/** Device identifiers that must not receive the assignment. */
	excluded?: string[];
	/** Why this assignment replaces an earlier one, when it does. */
	retryReason?: 'lease_expired' | 'worker_disconnected' | 'worker_relinquished';
	/**
	 * A worker to place the stage on before considering any other, used when the stage keeps
	 * state in the memory of one device and must go back to the device holding that state.
	 */
	preferredWorkerDeviceId?: string | undefined;
	/**
	 * Whether the assignment the preferred worker previously held has already been released.
	 * This decides how that worker's assignment counter is compared against its own limit.
	 */
	isPreviousAssignmentReleased?: boolean;
};

/**
 * Decides which worker runs which stage, and keeps tasks moving.
 *
 * Everything about advancing a task lives here: placing the next stage on a worker, putting a
 * task back in the queue when no worker can take it, retrying an assignment whose lease ran
 * out, and telling the consumer and any observers that a task has changed.
 */
export class TaskScheduler {
	/**
	 * @param taskStore The store holding every task.
	 * @param deviceRegistry The registry the candidate workers are found in.
	 * @param stagePolicyResolver The source of each stage's own settings.
	 * @param hub The open connections, used to reach workers and task readers.
	 * @param announcer The announcer told when a worker's assignment count changes.
	 * @param maximumAttempts How many times one stage may be assigned before the task fails.
	 */
	constructor(
		private readonly taskStore: TaskStore,
		private readonly deviceRegistry: DeviceRegistry,
		private readonly stagePolicyResolver: StagePolicyResolver,
		private readonly hub: ConnectionHub,
		private readonly announcer: DeviceAnnouncer,
		private readonly maximumAttempts: number,
	) { }

	/**
	 * Assigns a task stage to an available worker device.
	 *
	 * @param taskId The task identifier to assign.
	 * @param value The value that the worker must process.
	 * @param stage The stage to assign.
	 * @param options How this assignment differs from placing the stage on any free worker.
	 */
	assign(taskId: string, value: StagePayload, stage: StageName, options: AssignOptions = {}): void {
		const { excluded = [], retryReason, preferredWorkerDeviceId, isPreviousAssignmentReleased = false } = options;
		const existing = this.taskStore.get(taskId);
		if (existing === undefined || existing.state === 'cancelled' || existing.state === 'completed' || existing.state === 'failed') return;
		if (existing.currentStageAttempts >= this.maximumAttempts) {
			this.taskStore.update(taskId, { state: 'failed', error: 'MAX_ATTEMPTS_EXHAUSTED', assignment: undefined });
			this.broadcastTask(taskId);
			return;
		}
		const preferred = preferredWorkerDeviceId === undefined
			? undefined
			: WorkerPlacement.reusableWorker(this.deviceRegistry, preferredWorkerDeviceId, stage, { isPreviousAssignmentReleased });
		const device = preferred ?? (retryReason === undefined
			? this.deviceRegistry.findWorker(stage, excluded) ?? this.deviceRegistry.findWorker(stage)
			: this.deviceRegistry.findWorker(stage, excluded));
		if (device === undefined) {
			this.taskStore.update(taskId, { state: 'queued', assignment: undefined });
			this.broadcastTask(taskId);
			return;
		}
		if (existing.assignment !== undefined) {
			this.announcer.releaseWorkerAssignment(existing.assignment.workerDeviceId);
			// A worker no longer learns that its assignment was superseded from a task
			// snapshot, because task updates are not sent to workers any more. Tell the
			// superseded worker directly, so it can drop any state it holds for the task.
			const supersededSocket = this.hub.socketMap.get(existing.assignment.workerDeviceId);
			if (supersededSocket !== undefined) {
				this.hub.send(supersededSocket, { type: 'stage.cancel', taskId, assignmentId: existing.assignment.assignmentId, attempt: existing.assignment.attempt, reason: retryReason ?? 'assignment_superseded' }, this.hub.counterpartFor(existing.assignment.workerDeviceId));
			}
		}
		const task = this.taskStore.assign(taskId, device.deviceId, stage, value, retryReason, this.stagePolicyResolver.resolve(existing, stage).leaseMs);
		this.announcer.occupyWorkerAssignment(device.deviceId);
		const socket = this.hub.socketMap.get(device.deviceId);
		const assignment = task.assignment;
		if (socket !== undefined && assignment !== undefined) {
			// The worker is told which computation to run and which position in its pipeline this
			// stage occupies, so it never has to recognise the stage name to know what to do.
			const specification = this.stagePolicyResolver.stageSpecification(existing, stage);
			this.hub.send(socket, {
				type: 'stage.assign',
				taskId,
				assignmentId: assignment.assignmentId,
				attempt: assignment.attempt,
				stage,
				computation: specification?.computation ?? stage,
				stageIndex: Math.max(0, (existing.pipelineStages ?? []).indexOf(stage)),
				value,
				leaseUntil: assignment.leaseUntil,
			}, { role: device.deviceRole, deviceId: device.deviceId });
		}
		this.broadcastTask(taskId);
	}

	/** Places every queued task whose next stage a worker can now run, and fails the expired. */
	scheduleQueuedTasks(): void {
		for (const task of this.taskStore.list()) {
			if (task.state !== 'queued') continue;
			if (Date.parse(task.submissionDeadlineAt) <= Date.now()) {
				this.taskStore.update(task.taskId, { state: 'failed', error: 'SUBMISSION_DEADLINE_EXPIRED' });
				this.broadcastTask(task.taskId);
				continue;
			}
			const stage = TaskStore.nextStage(task);
			if (stage === undefined) continue;
			// A task waits in the queue when no worker advertised the stage that comes next. If that
			// stage keeps state in the memory of one device, the wait must not be ended by handing
			// the stage to whichever worker connected first: only the device holding the state can
			// carry the stage on. The task holds no assignment while it is queued, so nothing is
			// discounted from the preferred worker's assignment counter.
			const preferredWorkerDeviceId = WorkerPlacement.preferredWorkerDeviceId(task, stage, this.stagePolicyResolver.resolve(task, stage));
			this.assign(task.taskId, task.completedStages.at(-1)?.value ?? StagePayloadFactory.initial(task.input), stage, { preferredWorkerDeviceId, isPreviousAssignmentReleased: true });
		}
	}

	/**
	 * Retries every assignment whose lease has run out without the worker extending it.
	 *
	 * A stage that keeps state between assignments is retried on the same worker rather than
	 * away from it. Moving such a stage elsewhere throws away the state the previous worker
	 * holds — for a language-model shard, its key-value cache — at exactly the moment the model
	 * is slow, so the retry is more likely to be slow again than the attempt it replaced. A
	 * stage that keeps no state is still retried away from the worker that missed its lease.
	 */
	recoverAssignments(): void {
		for (const task of this.taskStore.list()) {
			const assignment = task.assignment;
			if (assignment === undefined || Date.parse(assignment.leaseUntil) > Date.now()) continue;
			const policy = this.stagePolicyResolver.resolve(task, assignment.stage);
			if (policy.prefersSameWorkerOnRetry) {
				this.assign(task.taskId, assignment.value, assignment.stage, { retryReason: 'lease_expired', preferredWorkerDeviceId: assignment.workerDeviceId });
				continue;
			}
			this.assign(task.taskId, assignment.value, assignment.stage, { excluded: [assignment.workerDeviceId], retryReason: 'lease_expired' });
		}
	}

	/**
	 * Retries every assignment held by a worker whose connection has closed.
	 *
	 * @param deviceId The worker that disconnected.
	 */
	recoverWorkerAssignments(deviceId: string): void {
		for (const task of this.taskStore.list()) {
			const assignment = task.assignment;
			if (assignment?.workerDeviceId === deviceId) this.assign(task.taskId, assignment.value, assignment.stage, { excluded: [deviceId], retryReason: 'worker_disconnected' });
		}
	}

	/**
	 * Broadcasts the slim projection of a task on every revision, when the task exists.
	 *
	 * The projection carries only what changes as a task advances, so its size does not
	 * grow with the number of stages the task runs. A recipient that needs the task input,
	 * the completed stage values, or the change log asks for them with `task.get`,
	 * `task.resync`, or `task.history`.
	 *
	 * The assigned worker is deliberately not a recipient. A worker sees only its own
	 * stage, which `stage.assign` already carries in full. Sending the whole task to a
	 * worker would disclose the original task input, the identity of the consumer that
	 * submitted the task, and the results of every other stage.
	 *
	 * @param taskId The task identifier to broadcast.
	 */
	broadcastTask(taskId: string): void {
		const task = this.taskStore.get(taskId);
		if (task === undefined) return;
		const update = TaskProjection.update(task);
		const recipients = new Set<string>([task.consumerDeviceId, ...(this.hub.taskObserverDeviceIds.get(taskId) ?? [])]);
		for (const recipient of recipients) {
			const recipientSocket = this.hub.socketMap.get(recipient);
			if (recipientSocket !== undefined) this.hub.send(recipientSocket, { type: 'task.updated', update }, this.hub.counterpartFor(recipient));
		}
	}

	/**
	 * Reports whether a connection is allowed to read a whole task.
	 *
	 * Holding a stage assignment does not grant this permission: a worker sees only the
	 * stage it was assigned, never the whole task.
	 *
	 * @param deviceId The identifier of the connection asking to read the task.
	 * @param taskId The task identifier being read.
	 * @returns `true` when the connection owns the task or was granted observation of it.
	 */
	mayReadTask(deviceId: string, taskId: string): boolean {
		const task = this.taskStore.get(taskId);
		return task?.consumerDeviceId === deviceId || this.hub.taskObserverDeviceIds.get(taskId)?.has(deviceId) === true;
	}
}
