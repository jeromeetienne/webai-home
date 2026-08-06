import type { ClientMessage } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LeaseHeartbeat — tells the gateway this worker is still working on its assignment
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The shortest gap allowed between two lease heartbeats, in milliseconds.
 *
 * A very short lease would otherwise make this worker send heartbeats continuously.
 */
const minimumHeartbeatIntervalMs = 1_000;

/** The repeating timer that extends the lease of one running assignment, by stage assignment identifier. */
const leaseHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Keeps the lease of a running assignment alive.
 *
 * The gateway takes an assignment away from a worker whose lease runs out, so a stage that takes
 * longer than its lease would be reassigned while it is still running and its eventual result
 * refused as stale. Sending `stage.heartbeat` says the worker is still working, and the gateway
 * answers with a later lease expiry.
 *
 * This is the Node.js counterpart of the worker browser page's own
 * `packages/worker_webpage/web/src/connection/lease_heartbeat.ts`, and follows the same rule of
 * three heartbeats per lease.
 */
export class LeaseHeartbeat {
	/**
	 * Starts extending the lease of an assignment this worker is working on.
	 *
	 * The heartbeat is sent three times per lease, so a single lost or late message does not cost
	 * the assignment.
	 *
	 * @param sendMessage Sends one message to the central gateway.
	 * @param stageAssignment The task, stage assignment, attempt, and lease expiry from `stage.assign`.
	 */
	static start(
		sendMessage: (message: ClientMessage) => void,
		stageAssignment: { taskId: string; stageAssignmentId: string; attempt: number; leaseUntil?: string | undefined },
	): void {
		const leaseMs = stageAssignment.leaseUntil === undefined ? Number.NaN : Date.parse(stageAssignment.leaseUntil) - Date.now();
		const intervalMs = Number.isFinite(leaseMs)
			? Math.max(minimumHeartbeatIntervalMs, Math.floor(leaseMs / 3))
			: minimumHeartbeatIntervalMs;
		const timer = setInterval((): void => {
			sendMessage({
				type: 'stage.heartbeat',
				taskId: stageAssignment.taskId,
				stageAssignmentId: stageAssignment.stageAssignmentId,
				attempt: stageAssignment.attempt,
			});
		}, intervalMs);
		// The heartbeat must never be the reason this process stays alive: a worker with nothing
		// to do should be free to exit once its connection has closed.
		timer.unref?.();
		leaseHeartbeatTimers.set(stageAssignment.stageAssignmentId, timer);
	}

	/**
	 * Stops extending the lease of an assignment this worker is no longer working on.
	 *
	 * @param stageAssignmentId The stage assignment whose heartbeat should stop. When it is not
	 * given, every running heartbeat stops, which is what a closed connection needs.
	 */
	static stop(stageAssignmentId?: string): void {
		if (stageAssignmentId === undefined) {
			for (const timer of leaseHeartbeatTimers.values()) {
				clearInterval(timer);
			}
			leaseHeartbeatTimers.clear();
			return;
		}
		const timer = leaseHeartbeatTimers.get(stageAssignmentId);
		if (timer === undefined) {
			return;
		}
		clearInterval(timer);
		leaseHeartbeatTimers.delete(stageAssignmentId);
	}
}
