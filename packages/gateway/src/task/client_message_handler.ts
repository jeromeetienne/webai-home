import { StagePayloadFactory, type ClientMessage, type Device } from '@webai/protocol';
import { TaskProjection } from '@webai/protocol/task_projection';
import type { WebSocket } from 'ws';
import type { ConnectionHub } from '../connection/connection_hub.js';
import type { DeviceAnnouncer } from '../device/device_announcer.js';
import type { DeviceRegistry } from '../device/device_registry.js';
import type { PipelineRegistry } from './pipeline_registry.js';
import type { Session, SessionRegistry } from './session_registry.js';
import type { StagePolicyResolver } from './stage_policy_resolver.js';
import type { TaskScheduler } from './task_scheduler.js';
import { TaskStore } from './task_store.js';
import { WorkerPlacement } from '../device/worker_placement.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ClientMessageHandler — acts on each validated message a connected client sends
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Carries out one client message at a time.
 *
 * The messages fall into four groups, and they are tried in this order because the order is
 * part of the rules: the messages a connection may send before it has registered, then the
 * ones that read task state, then the ones that change it, then the stage messages a worker
 * sends about the assignment it holds. Everything after the first group requires a registered
 * device.
 */
export class ClientMessageHandler {
	/**
	 * @param hub The open connections, and the only place a message is written to one.
	 * @param deviceRegistry The registry of connected devices.
	 * @param taskStore The store holding every task.
	 * @param pipelineRegistry The authority on which pipelines and stage names exist.
	 * @param sessionRegistry The authenticated sessions.
	 * @param stagePolicyResolver The source of each stage's own settings.
	 * @param scheduler The scheduler that places stages and reports task progress.
	 * @param announcer The announcer of device changes.
	 * @param authToken The bearer token a connection must present.
	 * @param maximumTasksPerPrincipal How many tasks one principal may have in flight.
	 */
	constructor(
		private readonly hub: ConnectionHub,
		private readonly deviceRegistry: DeviceRegistry,
		private readonly taskStore: TaskStore,
		private readonly pipelineRegistry: PipelineRegistry,
		private readonly sessionRegistry: SessionRegistry,
		private readonly stagePolicyResolver: StagePolicyResolver,
		private readonly scheduler: TaskScheduler,
		private readonly announcer: DeviceAnnouncer,
		private readonly authToken: string,
		private readonly maximumTasksPerPrincipal: number,
	) { }

	/**
	 * Handles one validated client message for a connected device.
	 *
	 * @param socket The WebSocket that sent the message.
	 * @param deviceId The identifier assigned to the WebSocket connection.
	 * @param message The client message to process.
	 * @param requestFrameId The identifier of the frame the message travelled in.
	 */
	handle(socket: WebSocket, deviceId: string, message: ClientMessage, requestFrameId: string): void {
		// The session expiry the gateway advertises is checked here, on every message, rather than
		// only at the moment a connection authenticates. An expired session is refused until the
		// client authenticates again on the same connection; the connection is never closed for it.
		const currentSession = this.sessionRegistry.active(deviceId);
		if (message.type !== 'authenticate' && currentSession === undefined) {
			this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'AUTHENTICATION_REQUIRED', 'Authenticate before using the protocol', { retryable: true });
			return;
		}
		if (this.handleBeforeRegistration(socket, deviceId, message, requestFrameId, currentSession)) return;

		if (this.deviceRegistry.get(deviceId) === undefined) {
			this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'NOT_REGISTERED', 'Register before sending this message');
			return;
		}
		const activeDevice = this.deviceRegistry.get(deviceId);
		if (activeDevice !== undefined) this.deviceRegistry.add({ ...activeDevice, lastSeenAt: new Date().toISOString() });

		if (this.handleTaskReads(socket, deviceId, message, requestFrameId)) return;
		if (this.handleTaskChanges(socket, deviceId, message, requestFrameId, currentSession)) return;
		if (this.handleStageMessages(socket, deviceId, message, requestFrameId)) return;

		if (message.type === 'signal') {
			const target = this.hub.socketMap.get(message.to);
			if (target !== undefined) {
				this.hub.send(target, { type: 'signal', from: deviceId, data: message.data }, this.hub.counterpartFor(message.to));
			}
			return;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Before Registration
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Handles the messages a connection may send before it has registered.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The client message.
	 * @param requestFrameId The identifier of the frame the message travelled in.
	 * @param currentSession The connection's active session, when it has one.
	 * @returns `true` when the message was one of this group and has been dealt with.
	 */
	private handleBeforeRegistration(socket: WebSocket, deviceId: string, message: ClientMessage, requestFrameId: string, currentSession: Session | undefined): boolean {
		if (message.type === 'observe') {
			this.hub.observerDeviceIds.add(deviceId);
			// An observer connection exists to watch the cluster, so observing implies a
			// device membership subscription and no separate "devices.subscribe" is needed.
			this.hub.deviceSubscriberIds.add(deviceId);
			this.sendDeviceList(socket, deviceId, requestFrameId);
			return true;
		}
		if (message.type === 'devices.subscribe') {
			this.hub.deviceSubscriberIds.add(deviceId);
			this.sendDeviceList(socket, deviceId, requestFrameId);
			return true;
		}
		if (message.type === 'devices.unsubscribe') {
			this.hub.deviceSubscriberIds.delete(deviceId);
			return true;
		}
		if (message.type === 'authenticate') {
			if (message.token !== this.authToken) {
				this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'AUTHENTICATION_REQUIRED', 'Credentials were rejected', { retryable: false });
				return true;
			}
			// Authenticating again on a connection that already has a session simply replaces it,
			// which is how a client renews before or after its session runs out.
			const session = this.sessionRegistry.open(deviceId, message.token);
			this.hub.send(socket, { type: 'authenticated', principal: session.principal, expiresAt: new Date(session.expiresAt).toISOString() }, this.hub.counterpartFor(deviceId), requestFrameId);
			return true;
		}
		// Answered before registration on purpose: a worker asks which pipelines the gateway has
		// loaded so it can decide which stages to advertise, and that decision has to be made
		// before it registers. A pipeline specification carries no task data.
		if (message.type === 'pipelines.get') {
			this.hub.send(socket, { type: 'pipelines', pipelines: this.pipelineRegistry.list().filter((specification) => specification.retired !== true) }, this.hub.counterpartFor(deviceId), requestFrameId);
			return true;
		}
		if (message.type === 'register') {
			this.register(socket, deviceId, message, requestFrameId, currentSession);
			return true;
		}
		return false;
	}

	/**
	 * Registers a connection as a worker or a consumer.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The `register` message.
	 * @param requestFrameId The identifier of the frame the message travelled in.
	 * @param currentSession The connection's active session.
	 */
	private register(socket: WebSocket, deviceId: string, message: Extract<ClientMessage, { type: 'register' }>, requestFrameId: string, currentSession: Session | undefined): void {
		// The pipeline registry is the authority on which stage names exist. The shared
		// protocol package only checks the shape of a stage name, so a worker advertising a
		// stage no loaded pipeline defines is told so here, rather than registering
		// successfully and then silently never receiving work.
		const undefinedStageNames = (message.stageNames ?? []).filter((stageName) => this.pipelineRegistry.definesStage(stageName) === false);
		if (message.role === 'worker' && undefinedStageNames.length > 0) {
			this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'VALIDATION', 'No loaded pipeline defines these stages', { retryable: false, details: { undefinedStageNames, definedStageNames: this.pipelineRegistry.stageNames() } });
			return;
		}
		const existingDevice = message.role === 'worker'
			? this.deviceRegistry.findByName(message.name, 'worker')
			: undefined;
		if (existingDevice !== undefined && existingDevice.deviceId !== deviceId) {
			// The replaced device is announced as having left. Removing it quietly left every
			// dashboard showing it next to the connection that replaced it, for as long as that
			// page stayed open, because the removal was the only thing that would have taken it
			// off the list (see https://github.com/webai-at-home/webai-at-home/issues/58).
			this.announcer.publishDevice(this.deviceRegistry.remove(existingDevice.deviceId));
			const existingSocket = this.hub.socketMap.get(existingDevice.deviceId);
			this.hub.socketMap.delete(existingDevice.deviceId);
			existingSocket?.close(1000, 'Replaced by a newer connection with the same worker name');
		}
		const device: Device = {
			deviceId,
			name: message.name,
			deviceRole: message.role,
			// A worker that names no stages is taken to run every stage the loaded pipelines
			// define, rather than a list of stage names written into the gateway.
			stageNames: message.role === 'worker'
				? (message.stageNames ?? this.pipelineRegistry.stageNames())
				: [],
			connectedAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString(),
			principal: currentSession?.principal ?? '',
			...(message.role === 'worker' ? { workerState: message.ready === false ? 'draining' as const : 'ready' as const, ready: message.ready ?? true, maxConcurrentAssignments: message.maxConcurrentAssignments ?? 1, activeAssignments: 0 } : {}),
		};
		const change = this.deviceRegistry.add(device);
		this.hub.send(socket, { type: 'registered', deviceId }, this.hub.counterpartFor(deviceId, message), requestFrameId);
		this.announcer.publishDevice(change);
		this.scheduler.scheduleQueuedTasks();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reading Tasks And Devices
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Handles the messages that read task state or the device list.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The client message.
	 * @param requestFrameId The identifier of the frame the message travelled in.
	 * @returns `true` when the message was one of this group and has been dealt with.
	 */
	private handleTaskReads(socket: WebSocket, deviceId: string, message: ClientMessage, requestFrameId: string): boolean {
		if (message.type === 'task.observe' || message.type === 'task.unobserve' || message.type === 'task.resync') {
			const task = this.taskStore.get(message.taskId);
			if (task === undefined) { this.sendTaskNotFound(socket, deviceId, requestFrameId, message.taskId); return true; }
			if (message.type === 'task.observe') {
				const requester = this.deviceRegistry.get(deviceId);
				if (requester?.deviceRole !== 'consumer' || (task.consumerDeviceId !== deviceId && this.hub.taskObserverDeviceIds.get(task.taskId)?.has(deviceId) !== true)) {
					this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'Task observation requires an owner grant', { taskId: task.taskId });
					return true;
				}
				const observers = this.hub.taskObserverDeviceIds.get(task.taskId) ?? new Set<string>();
				observers.add(deviceId);
				this.hub.taskObserverDeviceIds.set(task.taskId, observers);
			}
			if (message.type === 'task.resync' && this.scheduler.mayReadTask(deviceId, task.taskId) === false) {
				this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'This connection is not allowed to read the task', { taskId: task.taskId });
				return true;
			}
			if (message.type === 'task.unobserve') this.hub.taskObserverDeviceIds.get(task.taskId)?.delete(deviceId);
			if (message.type !== 'task.unobserve') this.hub.send(socket, { type: 'task.snapshot', task: TaskProjection.snapshot(task) }, this.hub.counterpartFor(deviceId), requestFrameId);
			return true;
		}
		if (message.type === 'task.history') {
			const task = this.taskStore.get(message.taskId);
			if (task === undefined) { this.sendTaskNotFound(socket, deviceId, requestFrameId, message.taskId); return true; }
			if (this.scheduler.mayReadTask(deviceId, task.taskId) === false) {
				this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'This connection is not allowed to read the task', { taskId: task.taskId });
				return true;
			}
			this.hub.send(socket, { type: 'task.history', taskId: task.taskId, events: task.events }, this.hub.counterpartFor(deviceId), requestFrameId);
			return true;
		}
		if (message.type === 'task.observer.grant' || message.type === 'task.observer.revoke') {
			const task = this.taskStore.get(message.taskId);
			if (task === undefined) { this.sendTaskNotFound(socket, deviceId, requestFrameId, message.taskId); return true; }
			if (task.consumerDeviceId !== deviceId) {
				this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'Only the task owner may manage observers', { taskId: task.taskId });
				return true;
			}
			const observer = this.deviceRegistry.get(message.consumerDeviceId);
			if (observer === undefined || observer.deviceRole !== 'consumer') {
				this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'VALIDATION', 'An observer must be a connected consumer', { taskId: task.taskId });
				return true;
			}
			const observers = this.hub.taskObserverDeviceIds.get(task.taskId) ?? new Set<string>();
			if (message.type === 'task.observer.grant') observers.add(message.consumerDeviceId);
			else observers.delete(message.consumerDeviceId);
			this.hub.taskObserverDeviceIds.set(task.taskId, observers);
			return true;
		}
		if (message.type === 'devices.resync') {
			this.sendDeviceList(socket, deviceId, requestFrameId);
			return true;
		}
		return false;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Changing Tasks And Worker State
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Handles the messages that submit, read, cancel a task, or change worker state.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The client message.
	 * @param requestFrameId The identifier of the frame the message travelled in.
	 * @param currentSession The connection's active session, when it has one.
	 * @returns `true` when the message was one of this group and has been dealt with.
	 */
	private handleTaskChanges(socket: WebSocket, deviceId: string, message: ClientMessage, requestFrameId: string, currentSession: Session | undefined): boolean {
		if (message.type === 'task.submit') {
			const device = this.deviceRegistry.get(deviceId);
			if (device?.deviceRole !== 'consumer') {
				this.hub.send(socket, { type: 'error', code: 'CONSUMER_REQUIRED', message: 'Only consumer browser tabs may submit tasks', requestId: message.requestId }, this.hub.counterpartFor(deviceId), requestFrameId);
				return true;
			}
			const existingTask = this.taskStore.findByRequest(deviceId, message.requestId);
			if (existingTask !== undefined) {
				if (JSON.stringify(existingTask.input) !== JSON.stringify(message.input)) {
					this.hub.send(socket, { type: 'error', code: 'REQUEST_ID_CONFLICT', message: 'requestId was already used with different task contents', requestId: message.requestId, taskId: existingTask.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
					return true;
				}
				this.hub.send(socket, { type: 'task.accepted', requestId: message.requestId, task: TaskProjection.snapshot(existingTask) }, this.hub.counterpartFor(deviceId), requestFrameId);
				return true;
			}
			// Read from the live session rather than from whatever principal was recorded when this
			// connection registered, so the limit always applies to whoever is authenticated now.
			const principal = currentSession?.principal ?? '';
			const activeTaskCount = this.taskStore.list().filter((candidate) => candidate.consumerPrincipal === principal && ['completed', 'failed', 'cancelled'].includes(candidate.state) === false).length;
			if (activeTaskCount >= this.maximumTasksPerPrincipal) {
				this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'RATE_LIMITED', 'The principal has reached its active-task limit', { requestId: message.requestId, retryable: true, details: { limit: this.maximumTasksPerPrincipal } });
				return true;
			}
			// Every task now runs a pipeline, including the formula and language-model ones. The
			// stage sequence is data the task carries rather than a sequence built into the
			// gateway, so a task whose pipeline is missing cannot be advanced at all.
			const pipeline = this.pipelineRegistry.select(message.input, message.pipelineId, message.pipelineVersion);
			if (pipeline === undefined) {
				this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'NO_COMPATIBLE_WORKER', 'No active compatible pipeline specification exists', { requestId: message.requestId, retryable: false });
				return true;
			}
			const task = this.taskStore.create(message.input, deviceId, message.requestId, principal, {
				pipelineId: pipeline.pipelineId,
				pipelineVersion: pipeline.version,
				pipelineStages: pipeline.stages.map((stage) => stage.name),
				...(pipeline.repeatsUntilDone === true ? { pipelineRepeatsUntilDone: true } : {}),
			});
			this.hub.send(socket, { type: 'task.accepted', requestId: message.requestId, task: TaskProjection.snapshot(task) }, this.hub.counterpartFor(deviceId), requestFrameId);
			const stage = TaskStore.nextStage(task);
			if (stage !== undefined) this.scheduler.assign(task.taskId, StagePayloadFactory.initial(message.input), stage);
			return true;
		}

		if (message.type === 'task.get') {
			const task = this.taskStore.get(message.taskId);
			if (task !== undefined && this.scheduler.mayReadTask(deviceId, task.taskId)) {
				this.hub.send(socket, { type: 'task.snapshot', task: TaskProjection.snapshot(task) }, this.hub.counterpartFor(deviceId), requestFrameId);
			} else if (task !== undefined) {
				this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'This connection is not allowed to read the task', { taskId: message.taskId });
			} else {
				this.hub.send(socket, { type: 'error', code: 'TASK_NOT_FOUND', message: 'Task was not found', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			}
			return true;
		}

		if (message.type === 'worker.state') {
			const device = this.deviceRegistry.get(deviceId);
			if (device === undefined || device.deviceRole !== 'worker') {
				this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may change worker state' }, this.hub.counterpartFor(deviceId), requestFrameId);
				return true;
			}
			this.announcer.publishDevice(this.deviceRegistry.add({ ...device, workerState: message.state, ready: message.state === 'ready', ...(message.maxConcurrentAssignments === undefined ? {} : { maxConcurrentAssignments: message.maxConcurrentAssignments }), lastSeenAt: new Date().toISOString() }));
			if (message.state === 'ready') this.scheduler.scheduleQueuedTasks();
			return true;
		}

		if (message.type === 'task.cancel') {
			const task = this.taskStore.get(message.taskId);
			if (task === undefined) {
				this.hub.send(socket, { type: 'error', code: 'TASK_NOT_FOUND', message: 'Task was not found', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
				return true;
			}
			if (task.consumerDeviceId !== deviceId) {
				this.hub.send(socket, { type: 'error', code: 'TASK_OWNER_MISMATCH', message: 'Only the task owner may cancel this task', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
				return true;
			}
			const assignment = task.assignment;
			const cancelled = this.taskStore.cancel(task.taskId, message.reason);
			if (assignment !== undefined) {
				this.announcer.releaseWorkerAssignment(assignment.workerDeviceId);
				const workerSocket = this.hub.socketMap.get(assignment.workerDeviceId);
				if (workerSocket !== undefined) this.hub.send(workerSocket, { type: 'stage.cancel', taskId: task.taskId, assignmentId: assignment.assignmentId, attempt: assignment.attempt, reason: message.reason }, this.hub.counterpartFor(assignment.workerDeviceId));
			}
			this.scheduler.broadcastTask(cancelled.taskId);
			return true;
		}
		return false;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Stage Messages From Workers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Handles the messages a worker sends about the assignment it holds.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The client message.
	 * @param requestFrameId The identifier of the frame the message travelled in.
	 * @returns `true` when the message was one of this group and has been dealt with.
	 */
	private handleStageMessages(socket: WebSocket, deviceId: string, message: ClientMessage, requestFrameId: string): boolean {
		// A worker that is still working on its stage extends the lease rather than losing the
		// assignment mid-computation. Without this, a stage that takes longer than the lease is
		// reassigned while it is still running, its eventual result is refused as stale, and the
		// work is thrown away.
		if (message.type === 'stage.heartbeat') {
			const device = this.deviceRegistry.get(deviceId);
			const task = this.taskStore.get(message.taskId);
			const assignment = task?.assignment;
			if (device === undefined || device.deviceRole !== 'worker') {
				this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may extend an assignment lease' }, this.hub.counterpartFor(deviceId), requestFrameId);
				return true;
			}
			// The gateway refuses to extend a lease for an assignment that is no longer current,
			// and says so with the same message it uses to withdraw an assignment, so the worker
			// stops work and drops any state it holds rather than finishing work nobody wants.
			if (task === undefined || assignment === undefined || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt || assignment.workerDeviceId !== deviceId) {
				this.hub.send(socket, { type: 'stage.cancel', taskId: message.taskId, assignmentId: message.assignmentId, attempt: message.attempt, reason: 'assignment_superseded' }, this.hub.counterpartFor(deviceId), requestFrameId);
				return true;
			}
			const leaseUntil = this.taskStore.renewLease(task.taskId, this.stagePolicyResolver.resolve(task, assignment.stage).leaseMs);
			if (leaseUntil === undefined) return true;
			this.hub.send(socket, { type: 'stage.lease.extended', taskId: task.taskId, assignmentId: assignment.assignmentId, attempt: assignment.attempt, leaseUntil }, this.hub.counterpartFor(deviceId), requestFrameId);
			return true;
		}

		if (message.type === 'stage.accepted' || message.type === 'stage.relinquish') {
			const device = this.deviceRegistry.get(deviceId);
			const task = this.taskStore.get(message.taskId);
			const assignment = task?.assignment;
			if (device === undefined || device.deviceRole !== 'worker') {
				this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may update assignments' }, this.hub.counterpartFor(deviceId), requestFrameId);
				return true;
			}
			if (task === undefined || assignment === undefined || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt || assignment.workerDeviceId !== deviceId) {
				this.hub.send(socket, { type: 'error', code: 'STALE_ASSIGNMENT', message: 'The stage assignment is no longer current', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
				return true;
			}
			if (message.type === 'stage.accepted') {
				this.taskStore.acceptAssignment(task.taskId);
				this.scheduler.broadcastTask(task.taskId);
			} else {
				this.scheduler.assign(task.taskId, assignment.value, assignment.stage, { excluded: [deviceId], retryReason: 'worker_relinquished' });
			}
			return true;
		}

		if (message.type === 'stage.result') {
			this.acceptStageResult(socket, deviceId, message, requestFrameId);
			return true;
		}

		if (message.type === 'stage.failed') {
			this.acceptStageFailure(socket, deviceId, message, requestFrameId);
			return true;
		}
		return false;
	}

	/**
	 * Records one completed stage, then either assigns the next stage or completes the task.
	 *
	 * @param socket The connection that sent the result.
	 * @param deviceId The worker that ran the stage.
	 * @param message The `stage.result` message.
	 * @param requestFrameId The identifier of the frame the message travelled in.
	 */
	private acceptStageResult(socket: WebSocket, deviceId: string, message: Extract<ClientMessage, { type: 'stage.result' }>, requestFrameId: string): void {
		const device = this.deviceRegistry.get(deviceId);
		if (device === undefined || device.deviceRole !== 'worker') {
			this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may return stage results' }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		const task = this.taskStore.get(message.taskId);
		if (task === undefined) {
			this.hub.send(socket, { type: 'error', code: 'TASK_NOT_FOUND', message: 'Task was not found', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		const assignment = task.assignment;
		if (assignment === undefined || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt) {
			if (task.acknowledgedAssignmentIds?.includes(message.assignmentId) === true) {
				this.hub.send(socket, { type: 'stage.result.accepted', taskId: task.taskId, assignmentId: message.assignmentId, attempt: message.attempt, revision: task.revision, status: task.state === 'completed' ? 'completed' : 'assigned' }, this.hub.counterpartFor(deviceId), requestFrameId);
				return;
			}
			this.hub.send(socket, { type: 'error', code: 'STALE_ASSIGNMENT', message: 'The stage assignment is no longer current', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (assignment.workerDeviceId !== deviceId) {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_OWNER_MISMATCH', message: 'Only the assigned worker may return this stage result', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (assignment.stage !== message.stage) {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_STAGE_MISMATCH', message: 'The stage result does not match the current assignment', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (task.state !== 'running') {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_NOT_ACCEPTED', message: 'A stage assignment must be accepted before returning a result', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		const updated = this.taskStore.addStage(task.taskId, { name: message.stage, value: message.value }, message.assignmentId);
		// A piece of an answer belongs to the revision that produced it and to no other, so it is
		// sent from here. Every revision that follows this one — the assignment of the next stage,
		// and the completion of the task — has already dropped it, and would otherwise be the
		// first thing broadcast after the piece existed. Only a task that asked for its answer in
		// pieces ever has one, so no other task is broadcast any more often than before.
		if (updated.newText !== undefined) this.scheduler.broadcastTask(updated.taskId);
		this.announcer.releaseWorkerAssignment(deviceId);
		const upcoming = TaskStore.nextStage(updated);
		if (upcoming === undefined) {
			const completed = this.taskStore.update(updated.taskId, { state: 'completed', result: message.value });
			this.scheduler.broadcastTask(updated.taskId);
			this.hub.send(socket, { type: 'stage.result.accepted', taskId: completed.taskId, assignmentId: message.assignmentId, attempt: message.attempt, revision: completed.revision, status: 'completed' }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		// A stage that keeps state in the memory of the device running it must be placed back
		// on the device holding that state: a language-model shard needs the key-value cache
		// and hand-off tensors that device holds, and a built-in language-model stage needs
		// the generation it is holding open. Which device that is comes from the task's own
		// record of which device ran each stage, falling back to the device that just
		// finished. A stage that keeps no such state is instead preferably moved to a
		// different device, to demonstrate several workers cooperating on one task. Each
		// stage states which of the two it is, so no task type is named here.
		const policy = this.stagePolicyResolver.resolve(updated, upcoming);
		this.scheduler.assign(updated.taskId, message.value, upcoming, {
			excluded: policy.prefersSameWorkerOnRetry ? [] : [deviceId],
			preferredWorkerDeviceId: WorkerPlacement.preferredWorkerDeviceId(updated, upcoming, policy, deviceId),
			// The assignment this result completes was released just above, so the preferred
			// worker's assignment counter is already correct and nothing may be discounted
			// from it. Discounting one here would let that worker hold one assignment more
			// than its own maxConcurrentAssignments allows.
			isPreviousAssignmentReleased: true,
		});
		const assigned = this.taskStore.get(updated.taskId);
		if (assigned === undefined) return;
		this.hub.send(socket, { type: 'stage.result.accepted', taskId: assigned.taskId, assignmentId: message.assignmentId, attempt: message.attempt, revision: assigned.revision, status: 'assigned' }, this.hub.counterpartFor(deviceId), requestFrameId);
	}

	/**
	 * Records that one stage failed, which fails the whole task.
	 *
	 * @param socket The connection that reported the failure.
	 * @param deviceId The worker that ran the stage.
	 * @param message The `stage.failed` message.
	 * @param requestFrameId The identifier of the frame the message travelled in.
	 */
	private acceptStageFailure(socket: WebSocket, deviceId: string, message: Extract<ClientMessage, { type: 'stage.failed' }>, requestFrameId: string): void {
		const device = this.deviceRegistry.get(deviceId);
		if (device === undefined || device.deviceRole !== 'worker') {
			this.hub.send(socket, { type: 'error', code: 'WORKER_REQUIRED', message: 'Only worker browser tabs may fail a stage' }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		const task = this.taskStore.get(message.taskId);
		if (task === undefined) {
			this.hub.send(socket, { type: 'error', code: 'TASK_NOT_FOUND', message: 'Task was not found', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		const assignment = task.assignment;
		if (assignment === undefined || assignment.assignmentId !== message.assignmentId || assignment.attempt !== message.attempt) {
			this.hub.send(socket, { type: 'error', code: 'STALE_ASSIGNMENT', message: 'The stage assignment is no longer current', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (assignment.workerDeviceId !== deviceId) {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_OWNER_MISMATCH', message: 'Only the assigned worker may fail this stage', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (assignment.stage !== message.stage) {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_STAGE_MISMATCH', message: 'The stage failure does not match the current assignment', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		if (task.state !== 'running') {
			this.hub.send(socket, { type: 'error', code: 'ASSIGNMENT_NOT_ACCEPTED', message: 'A stage assignment must be accepted before failing', taskId: message.taskId }, this.hub.counterpartFor(deviceId), requestFrameId);
			return;
		}
		this.taskStore.update(message.taskId, { state: 'failed', error: message.error, assignment: undefined });
		this.announcer.releaseWorkerAssignment(deviceId);
		this.scheduler.broadcastTask(message.taskId);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Shared Replies
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sends the full device list with the current membership revision.
	 *
	 * @param socket The connection to answer.
	 * @param deviceId The connection's device identifier.
	 * @param requestFrameId The identifier of the frame being answered.
	 */
	private sendDeviceList(socket: WebSocket, deviceId: string, requestFrameId: string): void {
		this.hub.send(socket, { type: 'devices', devices: this.announcer.connectedDevices(), revision: this.deviceRegistry.membershipRevision() }, this.hub.counterpartFor(deviceId), requestFrameId);
	}

	/**
	 * Says that a task the client named does not exist.
	 *
	 * @param socket The connection to answer.
	 * @param deviceId The connection's device identifier.
	 * @param requestFrameId The identifier of the frame being answered.
	 * @param taskId The task the client named.
	 */
	private sendTaskNotFound(socket: WebSocket, deviceId: string, requestFrameId: string, taskId: string): void {
		this.hub.sendError(socket, requestFrameId, this.hub.counterpartFor(deviceId), 'TASK_NOT_FOUND', 'Task was not found', { taskId });
	}
}
