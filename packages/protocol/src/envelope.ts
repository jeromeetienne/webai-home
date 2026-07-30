import { protocolVersion, supportedProtocolVersions, type ClientMessage, type GatewayEnvelope, type GatewayMessage } from './index.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Envelope — wraps a message for sending, and reads a received wrapper
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** A frame sent by a client, before its body has been validated by the gateway. */
export type ClientFrame = {
	v: number;
	id: string;
	ts: string;
	inReplyTo?: string;
	body: ClientMessage;
};

/**
 * Builds the wrapper that every frame travels in, and answers questions about a received one.
 *
 * Both sides of the protocol wrap the same way, so this lives in the shared package rather
 * than being written out again in the gateway, the consumer, and the worker browser page.
 */
export class Envelope {
	/**
	 * Wraps a message a client is sending to the gateway.
	 *
	 * @param body The message to send.
	 * @param id This frame's identifier. Defaults to a fresh one. A client keeps the returned
	 * identifier when it wants to match the gateway's answer to this request.
	 * @returns The frame to serialise and send.
	 */
	static fromClient(body: ClientMessage, id: string = Envelope.newId()): ClientFrame {
		return { v: protocolVersion, id, ts: new Date().toISOString(), body };
	}

	/**
	 * Wraps a message the gateway is sending to a client.
	 *
	 * @param body The message to send.
	 * @param inReplyTo The `id` of the request this answers. Leave it out for an unsolicited
	 * message the gateway pushes on its own initiative.
	 * @returns The frame to serialise and send.
	 */
	static fromGateway(body: GatewayMessage, inReplyTo?: string): GatewayEnvelope {
		return { v: protocolVersion, id: Envelope.newId(), ts: new Date().toISOString(), ...(inReplyTo === undefined ? {} : { inReplyTo }), body };
	}

	/**
	 * Reports whether the gateway can speak a protocol version.
	 *
	 * @param version The version stated by a received frame.
	 * @returns `true` when the version is one this build supports.
	 */
	static supportsVersion(version: number): boolean {
		return supportedProtocolVersions.includes(version);
	}

	/**
	 * Reports whether a received value looks like a message that was sent without a wrapper.
	 *
	 * A peer built before the wrapper existed sends the message on its own. Recognising that
	 * shape lets the gateway answer with a clear explanation of the version it now requires,
	 * rather than a bare complaint that the message did not validate.
	 *
	 * @param value The parsed JSON received on the connection.
	 * @returns `true` when the value carries a message type but no wrapper.
	 */
	static isUnwrappedMessage(value: unknown): boolean {
		if (typeof value !== 'object' || value === null) return false;
		const record = value as Record<string, unknown>;
		return typeof record.type === 'string' && record.body === undefined;
	}

	/** Generates one frame identifier. */
	private static newId(): string {
		return `message-${crypto.randomUUID()}`;
	}
}
