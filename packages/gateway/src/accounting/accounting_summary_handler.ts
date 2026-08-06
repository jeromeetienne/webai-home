import type { AccountSummaryRow, ClientMessage } from '@webai/protocol';
import type { WebSocket } from 'ws';
import type { ConnectionHub } from '../connection/connection_hub.js';
import type { AccountRegistry } from './account_registry.js';
import type { LedgerStore } from './ledger_store.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountingSummaryHandler — answers what every account holds, for an observer connection
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The one message this handler answers. */
type AccountingSummaryMessage = Extract<ClientMessage, { type: 'accounting.summaries.get' }>;

/**
 * Answers the one cluster-wide accounting read: what does every account hold.
 *
 * Every other accounting message in `AccountingQueryHandler` answers for the asking connection's own
 * account and no other. This is the one exception, and it is drawn narrowly on purpose: it is
 * answered only for an observer connection, the same connection type the device list already goes to
 * without being asked twice. An observer already sees every connected device; this lets the same
 * connection see every account's balance too, which is what the gateway's `/ledger` page is for.
 *
 * A row is built by joining one account's ledger summary with the little of its profile that makes
 * the row recognisable — its display name and when it registered — so a reader of the page does not
 * have to cross-reference two lists to answer one question. The join happens once, here, rather than
 * twice, once per list, on the client.
 */
export class AccountingSummaryHandler {
	/**
	 * @param hub The open connections, and the only place a message is written to one.
	 * @param accountRegistry The accounts a profile is read from.
	 * @param ledgerStore The ledger a balance is read from.
	 */
	constructor(
		private readonly hub: ConnectionHub,
		private readonly accountRegistry: AccountRegistry,
		private readonly ledgerStore: LedgerStore,
	) { }

	/**
	 * Reports whether one message is for this handler.
	 *
	 * @param message The client message.
	 * @returns `true` when it is the one accounting summary read.
	 */
	static isAccountingSummaryMessage(message: ClientMessage): message is AccountingSummaryMessage {
		return message.type === 'accounting.summaries.get';
	}

	/**
	 * Answers the accounting summary read.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 */
	handle(socket: WebSocket, deviceId: string, inReplyToMessageId: string): void {
		if (this.hub.observerDeviceIds.has(deviceId) === false) {
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHORISATION', 'Only an observer connection may read the accounting summary of every account', { retryable: false });
			return;
		}
		this.hub.send(socket, { type: 'accounting.summaries', summaries: this.summaries() }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
	}

	/**
	 * Builds one row per account this gateway has ever recorded or registered.
	 *
	 * The two sources do not agree with each other: a registered account may hold no ledger entries
	 * yet, and the shared development account holds entries but was never registered. Every account
	 * either source names is therefore included, so an operator sees a volunteer who has signed up but
	 * not yet worked, as well as the bucket anonymous work lands in.
	 *
	 * @returns One row per account, ordered by balance, highest first, ties broken by account
	 * identifier so the order is stable between two reads that changed nothing.
	 */
	private summaries(): AccountSummaryRow[] {
		const accountIds = new Set<string>([
			...this.accountRegistry.list().map((account) => account.accountId),
			...this.ledgerStore.summaries().map((summary) => summary.accountId),
		]);
		return [...accountIds]
			.map((accountId): AccountSummaryRow => {
				const profile = this.accountRegistry.get(accountId);
				const ledgerSummary = this.ledgerStore.summaryFor(accountId);
				return {
					...ledgerSummary,
					displayName: profile?.displayName ?? '',
					...(profile === undefined ? {} : { createdAt: profile.createdAt }),
				};
			})
			.sort((left, right) => right.balance - left.balance || left.accountId.localeCompare(right.accountId));
	}
}
