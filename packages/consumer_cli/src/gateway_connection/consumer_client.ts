import { AccountAuthentication, type AccountKeyPair, type ClientMessage, type GatewayEnvelope, type GatewayMessage, type ProtocolError, type TaskInput, type TaskSnapshot, type TaskUpdate } from '@webai/protocol';
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
	/**
	 * Called once the account is proved, or once it is clear it will not be.
	 *
	 * The account identifier is absent when this consumer holds no key pair, or when the gateway
	 * would not give it an account: in both cases the stages its tasks run are recorded against the
	 * shared development account rather than against this consumer.
	 */
	onAccountSettled?: (accountId: string | undefined) => void;
	/** Called with anything about the account worth logging or showing. */
	onAccountNote?: (note: string) => void;
	onTaskAccepted?: (task: TaskSnapshot) => void;
	/** Called with the full task state, in reply to a `task.get`, `task.resync`, or `task.observe`. */
	onTaskSnapshot?: (task: TaskSnapshot) => void;
	/** Called on every task revision, with the slim projection rather than the whole task. */
	onTaskUpdated?: (update: TaskUpdate) => void;
	/**
	 * Called with the whole error rather than only its text.
	 *
	 * A program that submits one task at a time needs no more than the text, but a program
	 * that keeps several submissions in flight on one connection needs the `code` to decide
	 * how to answer and the `taskRequestId` to know which submission failed. An error the client
	 * itself raises, such as a frame that could not be read, is reported with the same shape
	 * and the code `INVALID_MESSAGE`.
	 */
	onError?: (error: ProtocolError) => void;
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
 * The client authenticates as soon as the connection opens, proves which account it is when it was
 * given a key pair, registers itself as a consumer, submits tasks on request, and authenticates
 * again on its own before the session the gateway granted runs out. Everything it observes is
 * reported through the callbacks it was built with, so the same client serves the command line
 * program and a browser page.
 */
export class ConsumerClient {
	private isRegistered = false;
	/** The pending timer that authenticates again before the current session expires. */
	private sessionRenewalTimer: ReturnType<typeof setTimeout> | undefined;
	/** The account conversation of the current connection, when this consumer holds a key pair. */
	private accountAuthentication: AccountAuthentication | undefined;

	/**
	 * @param socket The already-built connection to the central gateway.
	 * @param callbacks The functions to call as the conversation proceeds.
	 * @param name The consumer name to register under.
	 * @param authenticationToken The bearer token the gateway requires.
	 * @param accountKeyPair This consumer's own account key pair. Left out, the consumer submits with
	 * no account of its own and the stages its tasks run are recorded against the shared development
	 * account.
	 */
	constructor(
		private readonly socket: TaskSocket,
		private readonly callbacks: ConsumerClientCallbacks = {},
		private readonly name = 'consumer',
		private readonly authenticationToken = 'development-token',
		private readonly accountKeyPair?: AccountKeyPair,
	) {
		socket.onopen = (): void => {
			this.callbacks.onConnectionChange?.(true);
			this.send({ type: 'deviceAuthenticate', token: this.authenticationToken });
		};
		socket.onmessage = (event): void => {
			this.handleMessage(typeof event.data === 'string' ? event.data : event.data.toString());
		};
		socket.onerror = (): void => {
			this.reportOwnError('The connection to the central gateway failed');
		};
		socket.onclose = (): void => {
			this.isRegistered = false;
			// The account belongs to the connection that proved it, so the next connection proves it again.
			this.accountAuthentication = undefined;
			this.clearSessionRenewal();
			this.callbacks.onConnectionChange?.(false);
		};
	}

	/**
	 * Builds the account conversation for this connection.
	 *
	 * @param accountKeyPair This consumer's key pair.
	 * @returns The conversation, not yet started.
	 */
	private buildAccountAuthentication(accountKeyPair: AccountKeyPair): AccountAuthentication {
		return new AccountAuthentication(accountKeyPair, (message: ClientMessage): void => {
			this.send(message);
		}, {
			onSettled: (accountId: string | undefined): void => {
				this.callbacks.onAccountSettled?.(accountId);
				if (this.isRegistered === false) this.send({ type: 'deviceRegister', role: 'consumer', name: this.name });
			},
			onNote: (note: string): void => {
				this.callbacks.onAccountNote?.(note);
			},
		});
	}

	/**
	 * Submits one task to the central gateway.
	 *
	 * @param input The task type and the value it carries.
	 * @param taskRequestId The identifier the gateway echoes on its answer.
	 * @returns The identifier this submission was sent under.
	 */
	submit(input: TaskInput, taskRequestId: string = crypto.randomUUID()): string {
		if (this.isRegistered === false) throw new Error('The consumer is not connected');
		this.send({ type: 'task.submit', taskRequestId, input });
		return taskRequestId;
	}

	/**
	 * Asks the central gateway to cancel one task this consumer submitted.
	 *
	 * A program that gives up on a task before it finishes — because whoever asked for it has
	 * gone, or because it waited as long as it is willing to — says so, so that the cluster
	 * stops assigning stages for work nobody is waiting for.
	 *
	 * @param taskId The identifier of the task to cancel.
	 * @param reason Why the task is being cancelled, which the gateway records on the task.
	 */
	cancel(taskId: string, reason: string): void {
		if (this.isRegistered === false) return;
		this.send({ type: 'task.cancel', taskId, reason });
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
	 * @returns The identifier of the frame, which the gateway echoes as `inReplyToMessageId` on
	 * its answer. Keep it to match an answer to this request.
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
			this.reportOwnError('The central gateway sent invalid data');
			return;
		}
		const message: GatewayMessage = frame.body;
		if (message === undefined) {
			this.reportOwnError('The central gateway sent a frame with no message in it');
			return;
		}
		this.callbacks.onMessage?.('received', message);
		if (message.type === 'deviceAuthenticated') {
			// The gateway enforces the expiry it advertises, so a consumer waiting on a task
			// for longer than one session has to authenticate again to keep its connection
			// usable. Registration only happens on the first one; a renewal must not repeat it.
			this.scheduleSessionRenewal(message.expiresAt);
			if (this.isRegistered || this.accountAuthentication !== undefined) return;
			// Proving which account this consumer is comes before registering, and therefore before any
			// task can be submitted, so no stage is ever run before the gateway knows whose credit it
			// spends. A consumer with no key pair registers straight away and spends nobody's.
			if (this.accountKeyPair === undefined) {
				// Reported just as an account that was proved is, so a caller is always told which of the
				// two happened rather than only hearing when there is an account.
				this.callbacks.onAccountSettled?.(undefined);
				this.send({ type: 'deviceRegister', role: 'consumer', name: this.name });
				return;
			}
			this.accountAuthentication = this.buildAccountAuthentication(this.accountKeyPair);
			this.accountAuthentication.begin();
			return;
		}
		if (this.accountAuthentication?.handleMessage(message) === true) return;
		if (message.type === 'deviceRegistered') {
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
			this.callbacks.onError?.(message);
			return;
		}
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
