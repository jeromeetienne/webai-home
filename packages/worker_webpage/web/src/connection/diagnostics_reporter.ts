import { maximumDiagnosticEntriesPerBatch, type DiagnosticEntry } from '@webai/protocol';
import { GatewayConfig } from './gateway_config';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DiagnosticsReporter — batches this browser's message log and posts it to the gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How long entries are collected before they are posted, in milliseconds. */
const flushIntervalMs = 2_000;

/**
 * How many entries may wait to be posted before the oldest are dropped.
 *
 * Diagnostics must never grow without bound in this page's memory, and must never become
 * more important than the work itself. If the gateway is unreachable or slow, the oldest
 * entries are discarded rather than retried forever.
 */
const maximumBufferedEntries = 1_000;

/**
 * Reports the messages this browser page saw to the central gateway, so the gateway can
 * append them to this worker's own log file. A browser page cannot write files itself.
 *
 * Reports travel over HTTP rather than over the WebSocket connection that carries
 * scheduling, so that reporting cannot compete with stage assignment and result collection
 * (see https://github.com/webai-at-home/webai-at-home/issues/50). They are sent in batches
 * on a timer rather than one message at a time, and they carry no message bodies: the
 * gateway is the other end of every connection this page has, so it has already recorded
 * every body itself. Each entry names the frame it describes, which is what joins it to the
 * gateway's own record of the same message.
 */
export class DiagnosticsReporter {
	/** Entries waiting to be posted. */
	private static buffer: DiagnosticEntry[] = [];
	/** The repeating timer that posts the buffered entries. */
	private static flushTimer: number | undefined;
	/** The device identifier the gateway issued, once this page has registered. */
	private static deviceId: string | undefined;
	/** The bearer token this page authenticates with. */
	private static authToken: string | undefined;
	/** How many entries have been dropped because the buffer was full. */
	private static droppedEntryCount = 0;

	/**
	 * Starts reporting for a registered worker.
	 *
	 * @param deviceId The device identifier the gateway issued this page when it registered.
	 * @param authToken The bearer token this page authenticates with.
	 */
	static start(deviceId: string, authToken: string): void {
		DiagnosticsReporter.deviceId = deviceId;
		DiagnosticsReporter.authToken = authToken;
		if (DiagnosticsReporter.flushTimer !== undefined) {
			return;
		}
		DiagnosticsReporter.flushTimer = window.setInterval(() => {
			void DiagnosticsReporter.flush();
		}, flushIntervalMs);
	}

	/**
	 * Stops reporting and posts whatever is still buffered.
	 *
	 * Called when the connection closes, so the last few messages before a disconnection are
	 * still recorded.
	 */
	static stop(): void {
		if (DiagnosticsReporter.flushTimer !== undefined) {
			window.clearInterval(DiagnosticsReporter.flushTimer);
			DiagnosticsReporter.flushTimer = undefined;
		}
		void DiagnosticsReporter.flush();
		DiagnosticsReporter.deviceId = undefined;
	}

	/**
	 * Buffers one message this page saw, to be posted with the next batch.
	 *
	 * @param direction Whether this page received the message from, or sent it to, the gateway.
	 * @param messageType The message's `type` field.
	 * @param messageId The identifier of the frame the message travelled in, when known.
	 */
	static record(direction: 'received' | 'sent', messageType: string, messageId?: string): void {
		if (DiagnosticsReporter.deviceId === undefined) {
			return;
		}
		if (DiagnosticsReporter.buffer.length >= maximumBufferedEntries) {
			DiagnosticsReporter.buffer.shift();
			DiagnosticsReporter.droppedEntryCount += 1;
		}
		DiagnosticsReporter.buffer.push({
			direction,
			messageType,
			timestamp: new Date().toISOString(),
			...(messageId === undefined ? {} : {
				messageId,
			}),
		});
	}

	/**
	 * Posts the buffered entries to the gateway, oldest first.
	 *
	 * Entries are removed from the buffer before the request is sent, and are not put back
	 * if it fails. Diagnostics are worth less than the memory a growing retry queue would
	 * cost, and a failed report is visible as a gap in the log file rather than silently
	 * delaying the work.
	 */
	static async flush(): Promise<void> {
		const deviceId = DiagnosticsReporter.deviceId;
		const authToken = DiagnosticsReporter.authToken;
		if (deviceId === undefined || authToken === undefined) {
			return;
		}
		if (DiagnosticsReporter.buffer.length === 0) {
			return;
		}

		const entries = DiagnosticsReporter.buffer.splice(0, maximumDiagnosticEntriesPerBatch);
		try {
			await fetch(GatewayConfig.assetUrl('/diagnostics'), {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken}` },
				body: JSON.stringify({ deviceId, entries }),
				// Diagnostics must not keep the page alive or block anything else it is doing.
				keepalive: true,
			});
		} catch {
			// The gateway may be unreachable, restarting, or refusing the report. Losing
			// diagnostics is acceptable; interrupting the worker's actual work is not.
		}
	}

	/**
	 * Returns how many entries have been dropped because the buffer filled up.
	 *
	 * @returns The number of entries dropped since this page loaded.
	 */
	static droppedCount(): number {
		return DiagnosticsReporter.droppedEntryCount;
	}
}
