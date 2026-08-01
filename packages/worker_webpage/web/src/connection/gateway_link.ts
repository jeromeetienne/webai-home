import type { ClientMessage } from '@webai/protocol';
import { Envelope } from '@webai/protocol/envelope';
import { DiagnosticsReporter } from './diagnostics_reporter';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewayLink — sends one message to the central gateway and records that it was sent
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Sends messages to the central gateway on behalf of this browser page. */
export class GatewayLink {
	/**
	 * Sends a message to the central gateway and notes it for this browser's diagnostics.
	 *
	 * The wrapper is built once here so that the identifier the gateway will see is the same
	 * identifier the diagnostic entry names, which is what lets the two records of one message
	 * be joined afterwards.
	 *
	 * @param socket The active WebSocket connection to the central gateway.
	 * @param message The client message to send.
	 */
	static send(socket: WebSocket, message: ClientMessage): void {
		const frame = Envelope.fromClient(message);
		if (socket.readyState !== WebSocket.OPEN) {
			return;
		}
		socket.send(JSON.stringify(frame));
		DiagnosticsReporter.record('sent', message.type, frame.id);
	}
}
