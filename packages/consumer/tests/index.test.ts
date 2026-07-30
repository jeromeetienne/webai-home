import assert from "node:assert/strict";
import test from "node:test";
import { MainHelper } from "../src/cli.js";
import { ConsumerClient, type TaskSocket } from "../src/consumer_client.js";
import { protocolVersion } from "@webai/protocol";

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
	/** Reads one frame this client sent, and checks the wrapper it travelled in. */
	const sentFrame = (index: number): { v: number; id: string; ts: string; body: Record<string, unknown> } => {
		const frame = JSON.parse(sent[index]) as { v: number; id: string; ts: string; body: Record<string, unknown> };
		assert.equal(frame.v, protocolVersion);
		assert.ok(frame.id.length > 0);
		assert.ok(Number.isFinite(Date.parse(frame.ts)));
		return frame;
	};
	/** Wraps a gateway message the way the gateway does, so the client can read it. */
	const gatewayFrame = (body: unknown, inReplyTo?: string): string =>
		JSON.stringify({ v: protocolVersion, id: `message-${Math.random()}`, ts: new Date().toISOString(), ...(inReplyTo === undefined ? {} : { inReplyTo }), body });

	const client = new ConsumerClient(socket, {}, "formula-consumer");
	socket.onopen?.();
	const authenticateFrame = sentFrame(0);
	assert.deepEqual(authenticateFrame.body, { type: "authenticate", token: "development-token" });
	socket.onmessage?.({ data: gatewayFrame({ type: "authenticated", principal: "principal-development", expiresAt: "2026-01-01T01:00:00.000Z" }, authenticateFrame.id) });
	const registerFrame = sentFrame(1);
	assert.deepEqual(registerFrame.body, { type: "register", role: "consumer", name: "formula-consumer" });
	socket.onmessage?.({ data: gatewayFrame({ type: "registered", deviceId: "device-1" }, registerFrame.id) });
	client.submit({ taskType: "task_type_dev_formula", input: 5 }, "request-formula-1");
	const submitFrame = sentFrame(2);
	assert.deepEqual(submitFrame.body, { type: "task.submit", requestId: "request-formula-1", input: { taskType: "task_type_dev_formula", input: 5 } });
	// Each frame carries its own identifier, so two requests of the same kind can be told apart.
	assert.notEqual(authenticateFrame.id, registerFrame.id);
	assert.notEqual(registerFrame.id, submitFrame.id);
});
