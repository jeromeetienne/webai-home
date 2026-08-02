import { z } from 'zod';
import { Identifier } from '../identifier.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Diagnostics — what a worker browser page reports about the messages it saw
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One message a worker browser page saw, as that page reports it to the gateway.
 *
 * A browser page cannot write its own log file, so it tells the gateway which messages it
 * saw and when, and the gateway appends them to that worker's log file on its behalf.
 *
 * This carries no message body. The gateway is one end of every connection the worker has,
 * so it has already recorded the body of every message named here. The only fact the worker
 * adds is its own view of the timing, and `messageId` joins each entry to the gateway's own
 * record of the same message, which does carry the body.
 */
export const DiagnosticEntrySchema = z.object({
	/** Whether the worker received this message from, or sent it to, the gateway. */
	direction: z.enum(['received', 'sent']),
	/** The message's `type` field, such as "stage.assign". */
	messageType: z.string().min(1).max(200),
	/** When the worker saw the message, by the browser's own clock. */
	timestamp: z.string().datetime(),
	/** The identifier of the frame the message travelled in, for joining to the gateway's own record. */
	messageId: Identifier.optional(),
}).strict();
/** One message a worker browser page saw, as that page reports it to the gateway. */
export type DiagnosticEntry = z.infer<typeof DiagnosticEntrySchema>;

/** The largest number of entries one diagnostics report may carry. */
export const maximumDiagnosticEntriesPerBatch = 200;

/**
 * A batch of diagnostic entries, as posted to the gateway's diagnostics endpoint.
 *
 * Diagnostics travel over HTTP rather than over the WebSocket connection that carries
 * scheduling, so that reporting cannot compete with stage assignment and result collection
 * (see https://github.com/webai-at-home/webai-at-home/issues/50).
 */
export const DiagnosticsBatchSchema = z.object({
	/** The device identifier the gateway issued this worker when it registered. */
	deviceId: Identifier,
	/** The messages this worker saw since its last report. */
	entries: z.array(DiagnosticEntrySchema).min(1).max(maximumDiagnosticEntriesPerBatch),
}).strict();
/** A batch of diagnostic entries, as posted to the gateway's diagnostics endpoint. */
export type DiagnosticsBatch = z.infer<typeof DiagnosticsBatchSchema>;
