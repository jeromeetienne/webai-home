import { AccountIdentity, type ClientMessage } from '@webai/protocol';
import type { WebSocket } from 'ws';
import type { ConnectionHub } from '../connection/connection_hub.js';
import type { SessionRegistry } from '../task/session_registry.js';
import type { AccountRegistry } from './account_registry.js';
import type { ChallengeRegistry } from './challenge_registry.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountMessageHandler — registers an account, hands out a challenge, and checks a signature
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The account messages this handler answers. */
type AccountMessage = Extract<ClientMessage, { type: `account.${string}` }>;

/**
 * Answers the three messages that turn a connection into a named account.
 *
 * The gateway's other message handling is synchronous, and this handler is not: verifying a
 * signature goes through the Web Cryptography API, which is asynchronous everywhere it exists. That
 * is why these three messages live in a class of their own rather than in `ClientMessageHandler`,
 * which hands them over and does not wait.
 *
 * All three require a connection that has already authenticated with the gateway's shared token.
 * `ClientMessageHandler` refuses every message from a connection with no active session before this
 * handler is reached, so account registration is not open to a stranger who has presented nothing at
 * all.
 */
export class AccountMessageHandler {
	/**
	 * @param hub The open connections, and the only place a message is written to one.
	 * @param accountRegistry The accounts the gateway knows.
	 * @param challengeRegistry The one-time values handed out to be signed.
	 * @param sessionRegistry The sessions an authenticated account is recorded on.
	 */
	constructor(
		private readonly hub: ConnectionHub,
		private readonly accountRegistry: AccountRegistry,
		private readonly challengeRegistry: ChallengeRegistry,
		private readonly sessionRegistry: SessionRegistry,
	) { }

	/**
	 * Reports whether one message is for this handler.
	 *
	 * @param message The client message.
	 * @returns `true` when it is one of the account messages.
	 */
	static isAccountMessage(message: ClientMessage): message is AccountMessage {
		return message.type.startsWith('account.');
	}

	/**
	 * Answers one account message.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The account message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 * @returns Nothing.
	 */
	async handle(socket: WebSocket, deviceId: string, message: AccountMessage, inReplyToMessageId: string): Promise<void> {
		if (message.type === 'account.register') {
			await this.registerAccount(socket, deviceId, message, inReplyToMessageId);
			return;
		}
		if (message.type === 'account.challenge.request') {
			const issued = this.challengeRegistry.issue(deviceId);
			this.hub.send(socket, { type: 'account.challenge', challenge: issued.challenge, expiresAt: new Date(issued.expiresAt).toISOString() }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
			return;
		}
		await this.authenticateAccount(socket, deviceId, message, inReplyToMessageId);
	}

	/**
	 * Registers the account of one public key, or reports the account that key already has.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The `account.register` message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 * @returns Nothing.
	 */
	private async registerAccount(socket: WebSocket, deviceId: string, message: Extract<AccountMessage, { type: 'account.register' }>, inReplyToMessageId: string): Promise<void> {
		const accountId = await AccountIdentity.accountIdFor(message.publicKeySpkiBase64);
		const registered = this.accountRegistry.register({
			accountId,
			signatureAlgorithmName: message.signatureAlgorithmName,
			publicKeySpkiBase64: message.publicKeySpkiBase64,
			emailAddress: message.emailAddress ?? '',
			displayName: message.displayName ?? '',
		});
		this.hub.send(socket, { type: 'account.registered', account: registered.account, isNewAccount: registered.isNewAccount }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
	}

	/**
	 * Checks a signature over the challenge this connection was handed, and records the account on
	 * the connection's session when it holds.
	 *
	 * The challenge is taken before the signature is checked, so a refused attempt spends the
	 * challenge just as an accepted one does and the sender has to ask for a new value to sign.
	 *
	 * @param socket The connection that sent the message.
	 * @param deviceId The identifier assigned to the connection.
	 * @param message The `account.authenticate` message.
	 * @param inReplyToMessageId The identifier of the frame the message travelled in.
	 * @returns Nothing.
	 */
	private async authenticateAccount(socket: WebSocket, deviceId: string, message: Extract<AccountMessage, { type: 'account.authenticate' }>, inReplyToMessageId: string): Promise<void> {
		const account = this.accountRegistry.get(message.accountId);
		if (account === undefined) {
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'ACCOUNT_NOT_FOUND', 'Register this account before authenticating as it', { retryable: false });
			return;
		}
		const consumed = this.challengeRegistry.consume(deviceId);
		if (consumed.verdict !== 'accepted' || consumed.challenge === undefined) {
			const explanation = consumed.verdict === 'expired'
				? 'The challenge has expired. Ask for another one and sign that.'
				: 'There is no challenge outstanding on this connection. Ask for one and sign that.';
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'ACCOUNT_CHALLENGE_INVALID', explanation, { retryable: true });
			return;
		}
		const isVerified = await AccountIdentity.verifyChallengeSignature({
			signatureAlgorithmName: account.signatureAlgorithmName,
			publicKeySpkiBase64: account.publicKeySpkiBase64,
			challenge: consumed.challenge,
			signatureBase64: message.signatureBase64,
		});
		if (isVerified === false) {
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'ACCOUNT_SIGNATURE_REJECTED', 'The signature was not produced over this challenge by this account', { retryable: false });
			return;
		}
		const session = this.sessionRegistry.attachAccount(deviceId, account.accountId);
		if (session === undefined) {
			// The shared-token session ran out between the challenge and the signature. The account
			// itself is fine, so the client is told to authenticate the connection again rather than
			// that anything is wrong with its account or its key pair.
			this.hub.sendError(socket, inReplyToMessageId, this.hub.counterpartFor(deviceId), 'AUTHENTICATION_REQUIRED', 'The connection\'s session ran out. Authenticate the connection again, then authenticate the account.', { retryable: true });
			return;
		}
		this.hub.send(socket, { type: 'account.authenticated', accountId: account.accountId, expiresAt: new Date(session.expiresAt).toISOString() }, this.hub.counterpartFor(deviceId), inReplyToMessageId);
	}
}
