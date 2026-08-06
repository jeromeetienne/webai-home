import { z } from 'zod';
import { AccountDisplayName, AccountEmailAddress, AccountId, AccountPublicKeySpkiBase64, AccountSignatureAlgorithmName, AccountSignatureBase64 } from '../accounting/account_types.js';
import { LedgerDirection, maximumLedgerPageSize } from '../accounting/ledger_types.js';
import { Identifier, StageAssignmentId, TaskRequestId } from '../identifier.js';
import { StagePayloadSchema } from '../stage/stage_payload_types.js';
import { StageName } from '../task/pipeline_types.js';
import { TaskInput } from '../task/task_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ClientMessage — every message a client may send the gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every message a client may send the gateway, told apart by its `type`. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('observe') }).strict(),
	z.object({ type: z.literal('deviceAuthenticate'), token: z.string().min(1).max(4_000) }).strict(),
	// The three account messages are sent on a connection that has already authenticated with the
	// gateway's shared token, and they are what turns that connection from one of many holders of
	// the same token into one named account. "account.register" states a public key and the profile
	// that goes with it, "account.challenge.request" asks for a value to sign, and
	// "account.authenticate" proves the account's private key is held by signing that value.
	z.object({ type: z.literal('account.register'), signatureAlgorithmName: AccountSignatureAlgorithmName, publicKeySpkiBase64: AccountPublicKeySpkiBase64, emailAddress: AccountEmailAddress.optional(), displayName: AccountDisplayName.optional() }).strict(),
	z.object({ type: z.literal('account.challenge.request') }).strict(),
	z.object({ type: z.literal('account.authenticate'), accountId: AccountId, signatureBase64: AccountSignatureBase64 }).strict(),
	// The three accounting reads. Each names no account by default and is answered for the account the
	// connection has authenticated as; naming one is allowed so a client can state which account it
	// believes it is, and be told plainly when it is wrong rather than handed somebody else's balance.
	z.object({ type: z.literal('account.get'), accountId: AccountId.optional() }).strict(),
	z.object({ type: z.literal('account.balance.get'), accountId: AccountId.optional() }).strict(),
	z.object({ type: z.literal('account.ledger.get'), accountId: AccountId.optional(), direction: LedgerDirection.optional(), limit: z.number().int().min(1).max(maximumLedgerPageSize).optional(), before: Identifier.optional() }).strict(),
	// The one cluster-wide accounting read, answered for an observer connection only: every other
	// accounting message is answered for the connection's own account and no other. An observer
	// already sees the whole device list, so this reaches no further than an observer already does.
	z.object({ type: z.literal('accounting.summaries.get') }).strict(),
	z.object({ type: z.literal('task.observe'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('task.unobserve'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('task.resync'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('task.observer.grant'), taskId: Identifier, consumerDeviceId: Identifier }).strict(),
	z.object({ type: z.literal('task.observer.revoke'), taskId: Identifier, consumerDeviceId: Identifier }).strict(),
	z.object({ type: z.literal('devices.resync') }).strict(),
	z.object({ type: z.literal('devices.subscribe') }).strict(),
	z.object({ type: z.literal('devices.unsubscribe') }).strict(),
	z.object({ type: z.literal('deviceRegister'), role: z.enum(['worker', 'consumer']), name: z.string().min(1).max(200), stageNames: z.array(StageName).max(10).optional(), ready: z.boolean().optional(), maxConcurrentAssignments: z.number().int().min(1).max(100).optional() }).strict(),
	z.object({ type: z.literal('task.submit'), taskRequestId: TaskRequestId, input: TaskInput, pipelineId: Identifier.optional(), pipelineVersion: z.number().int().positive().optional() }).strict(),
	z.object({ type: z.literal('pipelines.get') }).strict(),
	z.object({ type: z.literal('task.get'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('task.history'), taskId: Identifier }).strict(),
	z.object({ type: z.literal('stage.result'), taskId: Identifier, stageAssignmentId: StageAssignmentId, attempt: z.number().int().positive(), stage: StageName, value: StagePayloadSchema }).strict(),
	z.object({ type: z.literal('stage.failed'), taskId: Identifier, stageAssignmentId: StageAssignmentId, attempt: z.number().int().positive(), stage: StageName, error: z.string().min(1).max(10_000) }).strict(),
	z.object({ type: z.literal('stage.accepted'), taskId: Identifier, stageAssignmentId: StageAssignmentId, attempt: z.number().int().positive() }).strict(),
	z.object({ type: z.literal('stage.relinquish'), taskId: Identifier, stageAssignmentId: StageAssignmentId, attempt: z.number().int().positive() }).strict(),
	z.object({ type: z.literal('stage.heartbeat'), taskId: Identifier, stageAssignmentId: StageAssignmentId, attempt: z.number().int().positive() }).strict(),
	z.object({ type: z.literal('task.cancel'), taskId: Identifier, reason: z.string().min(1).max(10_000) }).strict(),
	z.object({ type: z.literal('worker.state'), state: z.enum(['ready', 'draining']), maxConcurrentAssignments: z.number().int().min(1).max(100).optional() }).strict(),
	z.object({ type: z.literal('signal'), to: Identifier, data: z.unknown() }).strict(),
]);
/** Every message a client may send the gateway, told apart by its `type`. */
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
