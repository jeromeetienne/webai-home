import assert from "node:assert/strict";
import test from "node:test";
import { MainHelper } from "../src/cli.js";
import { ConsumerClient, type TaskSocket } from "../src/consumer_client.js";

test("parses finite numeric input", () => {
	assert.equal(MainHelper.parseInputFormula("12.5"), 12.5);
	assert.equal(MainHelper.parseInputFormula("-3"), -3);
});

test("rejects missing or non-finite input", () => {
	assert.throws(() => MainHelper.parseInputFormula(undefined), /Input must be a finite number/);
	assert.throws(() => MainHelper.parseInputFormula("not-a-number"), /Input must be a finite number/);
	assert.throws(() => MainHelper.parseInputFormula("Infinity"), /Input must be a finite number/);
});

test("validates large-language-model input", () => {
	assert.equal(MainHelper.parseInputLLM(" hello "), " hello ");
	assert.throws(() => MainHelper.parseInputLLM("  "), /Input must be a non-empty string/);
});

test("registers and submits through the shared client", () => {
	const sent: string[] = [];
	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: (data) => sent.push(data),
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	const client = new ConsumerClient(socket, {}, "formula-consumer");
	socket.onopen?.();
	assert.deepEqual(JSON.parse(sent[0]), { type: "authenticate", token: "development-token" });
	socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", principal: "principal-development", expiresAt: "2026-01-01T01:00:00.000Z" }) });
	assert.deepEqual(JSON.parse(sent[1]), { type: "register", role: "consumer", name: "formula-consumer" });
	socket.onmessage?.({ data: JSON.stringify({ type: "registered", deviceId: "device-1" }) });
	client.submit({ taskType: "task_type_formula", input: 5 }, "request-formula-1");
	assert.deepEqual(JSON.parse(sent[2]), { type: "task.submit", requestId: "request-formula-1", input: { taskType: "task_type_formula", input: 5 } });
});
