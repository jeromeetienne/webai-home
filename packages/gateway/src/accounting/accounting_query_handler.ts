import type { ClientMessage } from '@webai/protocol';
import type { WebSocket } from 'ws';
import type { ConnectionHub } from '../connection/connection_hub.js';
import type { SessionRegistry } from '../task/session_registry.js';
import type { AccountRegistry } from './account_registry.js';
import type { LedgerStore } from './ledger_store.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountingQueryHandler — answers what an account is, what it holds, and what it did
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The three accounting reads this handler answers. */
type AccountingQueryMessage = Extract<ClientMessage, { type: 'account.get' | 'account.balance.get' | 'account.ledger.get' }>;

/** The message types this handler answers, listed once so the dispatch and the type agree. */
const accountingQueryTypes: readonly AccountingQueryMessage['type'][] = ['account.get', 'account.balance.get', 'account.ledger.get'];

/**
 * Answers the three questions an account may ask about itself: what it is, what it holds, and what
 * it did.
 *
 * A connection may read its own account and no other. There is no operator view of the whole
 * cluster's accounting in Version 1, so a connection naming somebody else's account is refused
 * rather than answered — and naming an account at all is optional, because a connection that has
 * authenticated one already knows which account it is asking about. Naming it is what lets a client
 * state which account it believes it is and be told plainly when it is wrong, instead of being
 * handed a balance belonging to somebody else.
 *
 * This is a class of its own rather than three more branches of `ClientMessageHandler`, which is
 * already the largest file in the gateway.
 */
export class AccountingQueryHandler {
	/**
	 * @param hub The open connections, and the only place a message is written to one.
	 * @param accountRegistry The accounts a profile is read from.
	 * @param ledgerStore The ledger a balance and a history are read from.
	 * @param sessionRegistry The sessions the asking connection's own account is read from.
	 */
	constructor(
		private readonly hub: ConnectionHub,
		private readonly accountRegistry: AccountRegistry,
		private readonly ledgerStore: LedgerStore,
		private readonly sessionRegistry: SessionRegistry,
	) { }

	/**
	 * Reports whether one message is for this handler.
	 *
	 * @param message The client message.
	 * @returns `true` when it is one of the three accounting reads.
	 */
	static isAccountingQuery(message: ClientMessage): message is AccountingQueryMessage {
		return (accountingQueryTypes as readonly string[]).includes(message.type);
	}

	/**
	 * Answers one accounting read.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The accounting read.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 */
	handle(socket: WebSocket, deviceId: string, message: AccountingQueryMessage, inReplyToMessageId: string): void {
		const accountId = this.readableAccountId(socket, deviceId, message.accountId, inReplyToMessageId);
		if (accountId === undefined) {
			return;
		}
		if (message.type === 'account.get') {
			const account = this.accountRegistry.get(accountId);
			if (account === undefined) {
				this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'ACCOUNT_NOT_FOUND', 'This gateway holds no account with that identifier', { retryable: false });
				return;
			}
			this.hub.send(socket, { type: 'account.profile', account }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		if (message.type === 'account.balance.get') {
			this.hub.send(socket, { type: 'account.balance', summary: this.ledgerStore.summaryFor(accountId) }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		const direction = message.direction ?? 'both';
		const page = this.ledgerStore.entriesFor(accountId, { direction, limit: message.limit, before: message.before });
		this.hub.send(socket, {
			type: 'account.ledger',
			accountId,
			direction,
			entries: page.entries,
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
		}, this.hub.counterpartFor(deviceId), inReplyToMessageId);
	}

	/**
	 * Works out which account this connection is allowed to read, and refuses it when there is none.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param requestedAccountId The account the message named, when it named one.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 * @returns The account to answer for, or `undefined` when the connection has been refused and an
	 * error has already been sent.
	 */
	private readableAccountId(socket: WebSocket, deviceId: string, requestedAccountId: string | undefined, inReplyToMessageId: string): string | undefined {
		const sessionAccountId = this.sessionRegistry.active(deviceId)?.accountId;
		if (sessionAccountId === undefined) {
			// The connection has authenticated with the gateway's shared token and nothing more, which
			// names no participant, so there is no account of its own for it to read. It is told to
			// authenticate an account rather than that it is not allowed to read one.
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'ACCOUNT_REQUIRED', 'Authenticate an account on this connection before reading accounting information', { retryable: true });
			return undefined;
		}
		if (requestedAccountId !== undefined && requestedAccountId !== sessionAccountId) {
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'A connection may read its own account and no other', { retryable: false, details: { authenticatedAccountId: sessionAccountId } });
			return undefined;
		}
		return sessionAccountId;
	}
}
