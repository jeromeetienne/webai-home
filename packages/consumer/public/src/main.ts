import { createTaskInput, ConsumerClient, type TaskTypeName } from "../../src/consumer_client.js";

type TaskSocket = ConstructorParameters<typeof ConsumerClient>[0];

const get = <T extends HTMLElement>(id: string): T => {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Element ${id} was not found`);
	return element as T;
};
const url = get<HTMLInputElement>("url");
const type = get<HTMLSelectElement>("type");
const input = get<HTMLInputElement>("input");
const inputLabel = get<HTMLElement>("input-label");
const submit = get<HTMLButtonElement>("submit");
const clear = get<HTMLButtonElement>("clear");
const status = get<HTMLElement>("status");
const task = get<HTMLElement>("task");
let client: ConsumerClient | undefined;

const setStatus = (message: string, kind = ""): void => { status.textContent = message; status.className = `status ${kind}`; };
type.addEventListener("change", (): void => {
	inputLabel.firstChild!.textContent = type.value === "dev_formula" ? "Number" : "Prompt";
	input.placeholder = type.value === "dev_formula" ? "5" : "What is the capital of France?";
});
submit.addEventListener("click", (): void => {
	try {
		const taskInput = createTaskInput(type.value as TaskTypeName, input.value);
		client?.close();
		const socket = new WebSocket(url.value.trim()) as unknown as TaskSocket;
		client = new ConsumerClient(socket, {
			onConnectionChange: (connected) => setStatus(connected ? "Connected. Registering…" : "Disconnected", connected ? "good" : "bad"),
			onRegistered: () => { setStatus("Connected. Task submitted.", "good"); client?.submit(taskInput); },
			onTaskAccepted: (value) => { task.textContent = JSON.stringify(value, null, 2); },
			onTaskUpdated: (value) => { task.textContent = JSON.stringify(value, null, 2); setStatus(`Task ${value.state}.`, value.state === "failed" ? "bad" : "good"); },
			onError: (message) => setStatus(message, "bad"),
		});
		setStatus("Connecting…");
	} catch (error) { setStatus(error instanceof Error ? error.message : "The input could not be submitted", "bad"); }
});
clear.addEventListener("click", (): void => { task.textContent = "No task submitted yet."; });
