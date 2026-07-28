import type { ClientMessage, ServerMessage, Task, TaskInput } from "@webai/protocol";

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

export interface TaskClientCallbacks {
	onMessage?: (direction: "sent" | "received", message: ClientMessage | ServerMessage) => void;
	onRegistered?: (deviceId: string) => void;
	onTaskAccepted?: (task: Task) => void;
	onTaskUpdated?: (task: Task) => void;
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

export function createTaskInput(type: "formula" | "llm", value: string | undefined): TaskInput {
	return type === "formula"
		? { taskType: "task_type_formula", input: parseFormulaInput(value) }
		: { taskType: "task_type_llm", input: parseLlmInput(value) };
}

export class TaskClient {
	private registered = false;

	constructor(private readonly socket: TaskSocket, private readonly callbacks: TaskClientCallbacks = {}) {
		socket.onopen = (): void => {
			this.callbacks.onConnectionChange?.(true);
			this.send({ type: "register", role: "admin", name: "task-client" });
		};
		socket.onmessage = (event): void => this.handleMessage(typeof event.data === "string" ? event.data : event.data.toString());
		socket.onerror = (): void => this.callbacks.onError?.("The connection to the central server failed");
		socket.onclose = (): void => {
			this.registered = false;
			this.callbacks.onConnectionChange?.(false);
		};
	}

	submit(input: TaskInput): void {
		if (!this.registered) throw new Error("The task client is not connected");
		this.send({ type: "task.submit", input });
	}

	close(): void { this.socket.close(); }

	private send(message: ClientMessage): void {
		this.callbacks.onMessage?.("sent", message);
		this.socket.send(JSON.stringify(message));
	}

	private handleMessage(raw: string): void {
		let message: ServerMessage;
		try { message = JSON.parse(raw) as ServerMessage; }
		catch { this.callbacks.onError?.("The central server sent invalid data"); return; }
		this.callbacks.onMessage?.("received", message);
		if (message.type === "registered") {
			this.registered = true;
			this.callbacks.onRegistered?.(message.deviceId);
		} else if (message.type === "task.accepted") this.callbacks.onTaskAccepted?.(message.task);
		else if (message.type === "task.updated") this.callbacks.onTaskUpdated?.(message.task);
		else if (message.type === "error") this.callbacks.onError?.(message.message);
	}
}
