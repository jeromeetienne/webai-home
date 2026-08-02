import type { ClientMessage, Device, DeviceActivity, GatewayEnvelope, GatewayMessage, PipelineSpecification, ProtocolError } from '@webai/protocol';
import { Envelope } from '@webai/protocol/envelope';
import { SessionRenewal } from '@webai/protocol/session_renewal';
import type { TaskSocket } from './consumer_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ObserverClient — holds an observer's connection to the central gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The functions this client calls as the conversation with the central gateway proceeds. */
export type ObserverClientCallbacks = {
	/**
	 * Called with the full current device list, every time the central gateway reports a
	 * change to it — the initial `devices` reply to `observe`, and every `device.joined`,
	 * `device.updated`, `device.activity`, and `device.left` afterwards.
	 */
	onDevices?: (devices: Device[]) => void;
	/** Called once, with the pipelines the central gateway holds, in reply to `pipelines.get`. */
	onPipelines?: (pipelines: PipelineSpecification[]) => void;
	/** Called with the whole error the central gateway sent, or one this client raised itself. */
	onError?: (error: ProtocolError) => void;
	onConnectionChange?: (isConnected: boolean) => void;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Observer Client
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Speaks the observer side of the gateway protocol over one connection.
 *
 * The client authenticates as soon as the connection opens, then sends `observe`, which the
 * central gateway treats as a device membership subscription: it answers with the full
 * device list once, and afterwards sends only what changed. This client keeps its own copy of
 * that list, merges every change into it, and reports the current whole list back through
 * `onDevices` rather than making the caller reassemble it from each message shape.
 */
export class ObserverClient {
	private readonly deviceById = new Map<string, Device>();
	private isObserving = false;
	/** The pending timer that authenticates again before the current session expires. */
	private sessionRenewalTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * @param socket The already-built connection to the central gateway.
	 * @param callbacks The functions to call as the conversation proceeds.
	 * @param authenticationToken The bearer token the gateway requires.
	 * @param requestPipelines Whether to ask for the registered pipelines once authenticated,
	 * in addition to observing the device list.
	 */
	constructor(
		private readonly socket: TaskSocket,
		private readonly callbacks: ObserverClientCallbacks = {},
		private readonly authenticationToken = 'development-token',
		private readonly requestPipelines = false,
	) {
		socket.onopen = (): void => {
			this.callbacks.onConnectionChange?.(true);
			this.send({ type: 'deviceAuthenticate', token: this.authenticationToken });
		};
		socket.onmessage = (event): void => {
			this.handleMessage(typeof event.data === 'string' ? event.data : event.data.toString());
		};
		// The "close" event that always follows reports the disconnection on its own, through
		// `onConnectionChange` below. Reporting this as an `onError` too would misreport a
		// transport-level failure as `INVALID_MESSAGE`, the code reserved for a frame this
		// client could not read.
		socket.onerror = (): void => undefined;
		socket.onclose = (): void => {
			this.isObserving = false;
			this.clearSessionRenewal();
			this.callbacks.onConnectionChange?.(false);
		};
	}

	/** Cancels any pending session renewal and closes the connection. */
	close(): void {
		this.clearSessionRenewal();
		this.socket.close();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Sending And Receiving
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sends one message inside the wrapper every frame travels in.
	 *
	 * @param message The message to send.
	 */
	private send(message: ClientMessage): void {
		const frame = Envelope.fromClient(message);
		this.socket.send(JSON.stringify(frame));
	}

	/**
	 * Reads one frame the central gateway sent, and reports it through the callbacks.
	 *
	 * @param rawStr The frame as the text it arrived in.
	 */
	private handleMessage(rawStr: string): void {
		let frame: GatewayEnvelope;
		try {
			frame = JSON.parse(rawStr) as GatewayEnvelope;
		} catch {
			this.reportOwnError('The central gateway sent invalid data');
			return;
		}
		const message: GatewayMessage = frame.body;
		if (message === undefined) {
			this.reportOwnError('The central gateway sent a frame with no message in it');
			return;
		}
		if (message.type === 'deviceAuthenticated') {
			// A renewal answers with "deviceAuthenticated" too, and must not observe a second time.
			this.scheduleSessionRenewal(message.expiresAt);
			if (this.isObserving === false) {
				this.isObserving = true;
				this.send({ type: 'observe' });
				if (this.requestPipelines) this.send({ type: 'pipelines.get' });
			}
			return;
		}
		if (message.type === 'devices') {
			this.deviceById.clear();
			for (const device of message.devices) this.deviceById.set(device.deviceId, device);
			this.callbacks.onDevices?.([...this.deviceById.values()]);
			return;
		}
		if (message.type === 'device.joined' || message.type === 'device.updated') {
			this.deviceById.set(message.device.deviceId, message.device);
			this.callbacks.onDevices?.([...this.deviceById.values()]);
			return;
		}
		if (message.type === 'device.activity') {
			for (const activity of message.devices) this.mergeActivity(activity);
			this.callbacks.onDevices?.([...this.deviceById.values()]);
			return;
		}
		if (message.type === 'device.left') {
			this.deviceById.delete(message.deviceId);
			this.callbacks.onDevices?.([...this.deviceById.values()]);
			return;
		}
		if (message.type === 'pipelines') {
			this.callbacks.onPipelines?.(message.pipelines);
			return;
		}
		if (message.type === 'error') {
			this.callbacks.onError?.(message);
			return;
		}
	}

	/**
	 * Merges one device's changed activity fields into the stored device.
	 *
	 * Only the fields actually present are merged in. Spreading the whole activity record
	 * would overwrite a known value with undefined for any field the message left out, losing
	 * what the stored device already said about it.
	 *
	 * @param activity The changed activity fields for one device.
	 */
	private mergeActivity(activity: DeviceActivity): void {
		const stored = this.deviceById.get(activity.deviceId);
		if (stored === undefined) return;
		this.deviceById.set(activity.deviceId, {
			...stored,
			lastSeenAt: activity.lastSeenAt,
			...(activity.workerState === undefined ? {} : { workerState: activity.workerState }),
			...(activity.ready === undefined ? {} : { ready: activity.ready }),
			...(activity.activeAssignments === undefined ? {} : { activeAssignments: activity.activeAssignments }),
		});
	}

	/**
	 * Reports a failure this client noticed itself, in the same shape as an error the gateway
	 * sends, so that whoever reads the callback handles one shape rather than two.
	 *
	 * @param message What went wrong, in words.
	 */
	private reportOwnError(message: string): void {
		this.callbacks.onError?.({ type: 'error', code: 'INVALID_MESSAGE', message });
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Session Renewal
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Authenticates again before the current session runs out.
	 *
	 * @param expiresAt When the current session expires, as the gateway stated it.
	 */
	private scheduleSessionRenewal(expiresAt: string | undefined): void {
		this.clearSessionRenewal();
		if (expiresAt === undefined) return;
		this.sessionRenewalTimer = setTimeout((): void => {
			this.send({ type: 'deviceAuthenticate', token: this.authenticationToken });
		}, SessionRenewal.renewAfterMs(expiresAt));
		// A pending renewal must not be the only reason this process stays alive.
		this.sessionRenewalTimer.unref?.();
	}

	/** Cancels the pending session renewal, if there is one. */
	private clearSessionRenewal(): void {
		if (this.sessionRenewalTimer !== undefined) clearTimeout(this.sessionRenewalTimer);
		this.sessionRenewalTimer = undefined;
	}
}
