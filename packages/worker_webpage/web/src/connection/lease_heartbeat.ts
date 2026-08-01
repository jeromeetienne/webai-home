import type { ClientMessage } from '@webai/protocol';
import { GatewayLink } from './gateway_link';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LeaseHeartbeat — tells the gateway this browser is still working on its assignment
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The shortest gap allowed between two lease heartbeats, in milliseconds.
 *
 * A very short lease would otherwise make this browser send heartbeats continuously.
 */
const minimumHeartbeatIntervalMs = 1_000;

/** The repeating timer that extends the lease of one running assignment, by stage assignment identifier. */
const leaseHeartbeatTimers = new Map<string, number>();

/**
 * Keeps the lease of a running assignment alive.
 *
 * The gateway takes an assignment away from a worker whose lease runs out, so a stage that
 * takes longer than its lease would be reassigned while it is still running and its
 * eventual result refused as stale. Sending `stage.heartbeat` says the worker is still
 * working, and the gateway answers with a later lease expiry.
 */
export class LeaseHeartbeat {
	/**
	 * Starts extending the lease of an assignment this browser is working on.
	 *
	 * The heartbeat is sent three times per lease, so a single lost or late message does not
	 * cost the assignment.
	 *
	 * @param socket The open connection to the central gateway.
	 * @param stageAssignment The task, stage assignment, attempt, and lease expiry from `stage.assign`.
	 */
	static start(
		socket: WebSocket,
		stageAssignment: { taskId: string; stageAssignmentId: string; attempt: number; leaseUntil?: string | undefined },
	): void {
		const leaseMs = stageAssignment.leaseUntil === undefined ? Number.NaN : Date.parse(stageAssignment.leaseUntil) - Date.now();
		const intervalMs = Number.isFinite(leaseMs)
			? Math.max(minimumHeartbeatIntervalMs, Math.floor(leaseMs / 3))
			: minimumHeartbeatIntervalMs;
		const timer = window.setInterval((): void => {
			if (socket.readyState !== WebSocket.OPEN) {
				return;
			}
			const heartbeatMessage: ClientMessage = {
				type: 'stage.heartbeat',
				taskId: stageAssignment.taskId,
				stageAssignmentId: stageAssignment.stageAssignmentId,
				attempt: stageAssignment.attempt,
			};
			GatewayLink.send(socket, heartbeatMessage);
		}, intervalMs);
		leaseHeartbeatTimers.set(stageAssignment.stageAssignmentId, timer);
	}

	/**
	 * Stops extending the lease of an assignment this browser is no longer working on.
	 *
	 * @param stageAssignmentId The stage assignment whose heartbeat should stop. When it is not
	 * given, every running heartbeat stops, which is what a closed connection needs.
	 */
	static stop(stageAssignmentId?: string): void {
		if (stageAssignmentId === undefined) {
			for (const timer of leaseHeartbeatTimers.values()) {
				window.clearInterval(timer);
			}
			leaseHeartbeatTimers.clear();
			return;
		}
		const timer = leaseHeartbeatTimers.get(stageAssignmentId);
		if (timer === undefined) {
			return;
		}
		window.clearInterval(timer);
		leaseHeartbeatTimers.delete(stageAssignmentId);
	}
}
