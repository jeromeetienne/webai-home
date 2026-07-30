import type { ClientMessage, GatewayEnvelope, GatewayMessage, TaskInput, TaskSnapshot, TaskUpdate } from '@webai/protocol';
import { Envelope } from '@webai/protocol/envelope';
import { SessionRenewal } from '@webai/protocol/session_renewal';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ConsumerClient — holds a consumer's connection to the central gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The part of a WebSocket connection this client uses.
 *
 * Only these members are named, so that the same client works with the connection of the
 * `ws` package on the command line and with the connection built into a browser page.
 */
export type TaskSocket = {
	readonly readyState: number;
	readonly OPEN: number;
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: string | Buffer }) => void) | null;
	onerror: (() => void) | null;
	onclose: (() => void) | null;
};

/** The functions this client calls as the conversation with the central gateway proceeds. */
export type ConsumerClientCallbacks = {
	onMessage?: (direction: 'sent' | 'received', message: ClientMessage | GatewayMessage) => void;
	onRegistered?: (deviceId: string) => void;
	onTaskAccepted?: (task: TaskSnapshot) => void;
	/** Called with the full task state, in reply to a `task.get`, `task.resync`, or `task.observe`. */
	onTaskSnapshot?: (task: TaskSnapshot) => void;
	/** Called on every task revision, with the slim projection rather than the whole task. */
	onTaskUpdated?: (update: TaskUpdate) => void;
	onError?: (message: string) => void;
	onConnectionChange?: (isConnected: boolean) => void;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Consumer Client
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Speaks the consumer side of the gateway protocol over one connection.
 *
 * The client authenticates as soon as the connection opens, registers itself as a consumer,
 * submits tasks on request, and authenticates again on its own before the session the
 * gateway granted runs out. Everything it observes is reported through the callbacks it was
 * built with, so the same client serves the command line program and a browser page.
 */
export class ConsumerClient {
	private isRegistered = false;
	/** The pending timer that authenticates again before the current session expires. */
	private sessionRenewalTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * @param socket The already-built connection to the central gateway.
	 * @param callbacks The functions to call as the conversation proceeds.
	 * @param name The consumer name to register under.
	 * @param authenticationToken The bearer token the gateway requires.
	 */
	constructor(
		private readonly socket: TaskSocket,
		private readonly callbacks: ConsumerClientCallbacks = {},
		private readonly name = 'consumer',
		private readonly authenticationToken = 'development-token',
	) {
		socket.onopen = (): void => {
			this.callbacks.onConnectionChange?.(true);
			this.send({ type: 'authenticate', token: this.authenticationToken });
		};
		socket.onmessage = (event): void => {
			this.handleMessage(typeof event.data === 'string' ? event.data : event.data.toString());
		};
		socket.onerror = (): void => {
			this.callbacks.onError?.('The connection to the central gateway failed');
		};
		socket.onclose = (): void => {
			this.isRegistered = false;
			this.clearSessionRenewal();
			this.callbacks.onConnectionChange?.(false);
		};
	}

	/**
	 * Submits one task to the central gateway.
	 *
	 * @param input The task type and the value it carries.
	 * @param requestId The identifier the gateway echoes on its answer.
	 * @returns The identifier this submission was sent under.
	 */
	submit(input: TaskInput, requestId: string = crypto.randomUUID()): string {
		if (this.isRegistered === false) throw new Error('The consumer is not connected');
		this.send({ type: 'task.submit', requestId, input });
		return requestId;
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
	 * @returns The identifier of the frame, which the gateway echoes as `inReplyTo` on its
	 * answer. Keep it to match an answer to this request.
	 */
	private send(message: ClientMessage): string {
		const frame = Envelope.fromClient(message);
		this.callbacks.onMessage?.('sent', message);
		this.socket.send(JSON.stringify(frame));
		return frame.id;
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
			this.callbacks.onError?.('The central gateway sent invalid data');
			return;
		}
		const message: GatewayMessage = frame.body;
		if (message === undefined) {
			this.callbacks.onError?.('The central gateway sent a frame with no message in it');
			return;
		}
		this.callbacks.onMessage?.('received', message);
		if (message.type === 'authenticated') {
			// The gateway enforces the expiry it advertises, so a consumer waiting on a task
			// for longer than one session has to authenticate again to keep its connection
			// usable. Registration only happens on the first one; a renewal must not repeat it.
			this.scheduleSessionRenewal(message.expiresAt);
			if (this.isRegistered === false) this.send({ type: 'register', role: 'consumer', name: this.name });
			return;
		}
		if (message.type === 'registered') {
			this.isRegistered = true;
			this.callbacks.onRegistered?.(message.deviceId);
			return;
		}
		if (message.type === 'task.accepted') {
			this.callbacks.onTaskAccepted?.(message.task);
			return;
		}
		if (message.type === 'task.snapshot') {
			this.callbacks.onTaskSnapshot?.(message.task);
			return;
		}
		if (message.type === 'task.updated') {
			this.callbacks.onTaskUpdated?.(message.update);
			return;
		}
		if (message.type === 'error') {
			this.callbacks.onError?.(message.message);
			return;
		}
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
			this.send({ type: 'authenticate', token: this.authenticationToken });
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
