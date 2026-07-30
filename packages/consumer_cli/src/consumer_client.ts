import type { ClientMessage, GatewayEnvelope, GatewayMessage, TaskInput, TaskSnapshot, TaskUpdate } from "@webai/protocol";
import { Envelope } from "@webai/protocol/envelope";
import { SessionRenewal } from "@webai/protocol/session_renewal";

export interface TaskSocket {
	readonly readyState: number;
	readonly OPEN: number;
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: string | Buffer }) => void) | null;
	onerror: (() => void) | null;
	onclose: (() => void) | null;
}

export interface ConsumerClientCallbacks {
	onMessage?: (direction: "sent" | "received", message: ClientMessage | GatewayMessage) => void;
	onRegistered?: (deviceId: string) => void;
	onTaskAccepted?: (task: TaskSnapshot) => void;
	/** Called with the full task state, in reply to a `task.get`, `task.resync`, or `task.observe`. */
	onTaskSnapshot?: (task: TaskSnapshot) => void;
	/** Called on every task revision, with the slim projection rather than the whole task. */
	onTaskUpdated?: (update: TaskUpdate) => void;
	onError?: (message: string) => void;
	onConnectionChange?: (connected: boolean) => void;
}

export function parseFormulaInput(value: string | undefined): number {
	const input = Number(value);
	if (!Number.isFinite(input)) throw new Error("Input must be a finite number");
	return input;
}

export function parseLlmInput(value: string | undefined): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error("Input must be a non-empty string");
	return value;
}

/**
 * The task types a consumer may submit, each named as its task type without the leading
 * `task_type_`. This is the list the `-t/--type` command line option accepts.
 */
export const taskTypeNames = ["dev_formula", "llm_qwen3_0_6b_sharded", "llm_gemma_nano_chrome_full"] as const;

/** One of the task types a consumer may submit. */
export type TaskTypeName = typeof taskTypeNames[number];

/**
 * Reports whether a value names a task type a consumer may submit.
 *
 * @param value - The value given on the command line.
 * @returns `true` when it is one of `taskTypeNames`.
 */
export function isTaskTypeName(value: string): value is TaskTypeName {
	return (taskTypeNames as readonly string[]).includes(value);
}

/**
 * Builds the task input for one task type, checking the value it carries.
 *
 * @param type - The task type to submit, without the leading `task_type_`.
 * @param value - The value submitted with the task: a number for the development formula
 * task, and a prompt for either language-model task.
 * @returns The task input to submit to the gateway.
 */
export function createTaskInput(type: TaskTypeName, value: string | undefined): TaskInput {
	if (type === "dev_formula") return { taskType: "task_type_dev_formula", input: parseFormulaInput(value) };
	if (type === "llm_qwen3_0_6b_sharded") return { taskType: "task_type_llm_qwen3_0_6b_sharded", input: parseLlmInput(value) };
	return { taskType: "task_type_llm_gemma_nano_chrome_full", input: parseLlmInput(value) };
}

export class ConsumerClient {
	private registered = false;
	/** The pending timer that authenticates again before the current session expires. */
	private sessionRenewalTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly socket: TaskSocket, private readonly callbacks: ConsumerClientCallbacks = {}, private readonly name = "consumer", private readonly authenticationToken = "development-token") {
		socket.onopen = (): void => {
			this.callbacks.onConnectionChange?.(true);
			this.send({ type: "authenticate", token: this.authenticationToken });
		};
		socket.onmessage = (event): void => this.handleMessage(typeof event.data === "string" ? event.data : event.data.toString());
		socket.onerror = (): void => this.callbacks.onError?.("The connection to the central gateway failed");
		socket.onclose = (): void => {
			this.registered = false;
			if (this.sessionRenewalTimer !== undefined) clearTimeout(this.sessionRenewalTimer);
			this.sessionRenewalTimer = undefined;
			this.callbacks.onConnectionChange?.(false);
		};
	}

	submit(input: TaskInput, requestId: string = crypto.randomUUID()): string {
		if (!this.registered) throw new Error("The consumer is not connected");
		this.send({ type: "task.submit", requestId, input });
		return requestId;
	}

	close(): void {
		if (this.sessionRenewalTimer !== undefined) clearTimeout(this.sessionRenewalTimer);
		this.sessionRenewalTimer = undefined;
		this.socket.close();
	}

	/**
	 * Authenticates again before the current session runs out.
	 *
	 * @param expiresAt - When the current session expires, as the gateway stated it.
	 */
	private scheduleSessionRenewal(expiresAt: string | undefined): void {
		if (this.sessionRenewalTimer !== undefined) clearTimeout(this.sessionRenewalTimer);
		if (expiresAt === undefined) return;
		this.sessionRenewalTimer = setTimeout((): void => {
			this.send({ type: "authenticate", token: this.authenticationToken });
		}, SessionRenewal.renewAfterMs(expiresAt));
		// A pending renewal must not be the only reason this process stays alive.
		this.sessionRenewalTimer.unref?.();
	}

	/**
	 * Sends one message inside the wrapper every frame travels in.
	 *
	 * @param message - The message to send.
	 * @returns The identifier of the frame, which the gateway echoes as `inReplyTo` on its
	 * answer. Keep it to match an answer to this request.
	 */
	private send(message: ClientMessage): string {
		const frame = Envelope.fromClient(message);
		this.callbacks.onMessage?.("sent", message);
		this.socket.send(JSON.stringify(frame));
		return frame.id;
	}

	private handleMessage(raw: string): void {
		let frame: GatewayEnvelope;
		try { frame = JSON.parse(raw) as GatewayEnvelope; }
		catch { this.callbacks.onError?.("The central gateway sent invalid data"); return; }
		const message: GatewayMessage = frame.body;
		if (message === undefined) { this.callbacks.onError?.("The central gateway sent a frame with no message in it"); return; }
		this.callbacks.onMessage?.("received", message);
		if (message.type === "authenticated") {
			// The gateway enforces the expiry it advertises, so a consumer waiting on a task
			// for longer than one session has to authenticate again to keep its connection
			// usable. Registration only happens on the first one; a renewal must not repeat it.
			this.scheduleSessionRenewal(message.expiresAt);
			if (this.registered === false) this.send({ type: "register", role: "consumer", name: this.name });
		} else if (message.type === "registered") {
			this.registered = true;
			this.callbacks.onRegistered?.(message.deviceId);
		} else if (message.type === "task.accepted") this.callbacks.onTaskAccepted?.(message.task);
		else if (message.type === "task.snapshot") this.callbacks.onTaskSnapshot?.(message.task);
		else if (message.type === "task.updated") this.callbacks.onTaskUpdated?.(message.update);
		else if (message.type === "error") this.callbacks.onError?.(message.message);
	}
}
