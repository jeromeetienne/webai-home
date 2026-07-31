import { maximumSnapshotEventCount, type Task, type TaskSnapshot, type TaskUpdate, type TaskUpdateAssignment } from './index.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TaskProjection — builds the two task shapes that travel over the connection
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds the task shapes that travel over the connection from the task record the
 * gateway keeps in memory.
 *
 * The stored record holds the per-attempt assignment history and the complete change
 * log, both of which only ever grow and neither of which belongs on the connection.
 */
export class TaskProjection {
	/**
	 * Builds the full current state of a task, as sent when a client asks for a task.
	 *
	 * @param task - The stored task record.
	 * @returns The task snapshot to send.
	 */
	static snapshot(task: Task): TaskSnapshot {
		// The text one revision produced is dropped. A snapshot says what a task is, not what
		// just happened to it, and it already carries that same text inside `generatedText`. A
		// consumer that appends a piece wherever the protocol offers one would otherwise show the
		// most recent piece twice, which is exactly what a consumer asking for a snapshot after
		// missing some revisions is doing.
		const { assignmentAttempts: _assignmentAttempts, events, assignment, newText: _newText, ...rest } = task;
		return {
			...rest,
			...(assignment === undefined ? {} : { assignment: TaskProjection._assignment(assignment) }),
			recentEvents: events.slice(-maximumSnapshotEventCount),
		};
	}

	/**
	 * Builds the slim projection sent on every task revision.
	 *
	 * @param task - The stored task record.
	 * @returns The task update to send.
	 */
	static update(task: Task): TaskUpdate {
		return {
			taskId: task.taskId,
			revision: task.revision,
			state: task.state,
			updatedAt: task.updatedAt,
			completedStageCount: task.completedStages.length,
			currentStageAttempts: task.currentStageAttempts,
			...(task.assignment === undefined ? {} : { currentStage: task.assignment.stage, assignment: TaskProjection._assignment(task.assignment) }),
			// Only what this revision produced, never the answer so far, so the update stays the
			// same size however long the answer becomes. The task record already drops this on the
			// next revision that produces no text, so nothing sends a piece twice.
			...(task.newText === undefined ? {} : { newText: task.newText }),
			...(task.result === undefined ? {} : { result: task.result }),
			...(task.error === undefined ? {} : { error: task.error }),
		};
	}

	/**
	 * Strips the stage input value from an assignment, keeping only its identity.
	 *
	 * @param assignment - The stored assignment.
	 * @returns The assignment identity without the stage input value.
	 */
	private static _assignment(assignment: Task['assignment'] & {}): TaskUpdateAssignment {
		const { value: _value, ...identity } = assignment;
		return identity;
	}
}
