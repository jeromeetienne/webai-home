import { AccountIdentity, type AccountCryptoKey } from './account_identity.js';
import type { AccountSignatureAlgorithmName } from './account_types.js';
import type { ClientMessage } from '../message/client_message.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountAuthentication — the three messages that put a named account on a connection
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One participant's key pair, however that participant keeps it. */
export type AccountKeyPair = {
	/** Which signature algorithm the key pair uses. */
	signatureAlgorithmName: AccountSignatureAlgorithmName;
	/** The public key, in the `spki` encoding, as base64. */
	publicKeySpkiBase64: string;
	/** The account identifier the public key derives to. */
	accountId: string;
	/** The private key, which signs the challenge and never leaves the participant. */
	privateKey: AccountCryptoKey;
};

/**
 * One gateway message, as this conversation needs to read it.
 *
 * It is deliberately a small structural shape rather than the whole `GatewayMessage` union, so that a
 * caller reading frames into a looser type of its own — as a browser page does — can hand a message
 * straight over without converting it first.
 */
export type AccountAuthenticationMessage = {
	/** The message category. */
	type: string;
	/** The value to sign, on `account.challenge`. */
	challenge?: string | undefined;
	/** The account now on the connection, on `account.authenticated`. */
	accountId?: string | undefined;
	/** The error code, on `error`. */
	code?: string | undefined;
	/** What the gateway said, on `error`. */
	message?: string | undefined;
};

/** What this conversation reports back as it proceeds. */
export type AccountAuthenticationCallbacks = {
	/**
	 * Called once, when the account is proved or when it is clear it will not be.
	 *
	 * A caller waits for this before registering as a worker or submitting a task, so that no work is
	 * ever recorded before the gateway knows whose account it belongs to.
	 */
	onSettled: (accountId: string | undefined) => void;
	/** Called with anything worth showing or logging, whether it went well or not. */
	onNote?: ((note: string) => void) | undefined;
};

/**
 * Puts a named account on one connection, in three messages.
 *
 * Register the public key, ask for a value to sign, send the signature. Every participant does
 * exactly this — a worker browser tab, the consumer command line program, the OpenAI-compatible
 * server, and the Node.js worker — so it is written once here rather than four times, and none of
 * the four can drift away from the others.
 *
 * It lives in the shared protocol package for the same reason `SessionRenewal` does: it is client
 * behaviour every participant needs and the gateway does not, and it is written against nothing but
 * the messages and the Web Cryptography API, so it runs in a browser and in Node.js unchanged.
 *
 * A conversation that cannot finish settles with no account rather than failing. An older gateway
 * that does not know these messages, or a participant with no key pair, still contributes and still
 * consumes; its work is recorded against the shared development account instead of its own.
 */
export class AccountAuthentication {
	/** Whether the conversation has already finished, one way or the other. */
	private isSettled = false;

	/**
	 * @param keyPair The participant's key pair.
	 * @param send How to send one message to the gateway.
	 * @param callbacks What to report back as the conversation proceeds.
	 */
	constructor(
		private readonly keyPair: AccountKeyPair,
		private readonly send: (message: ClientMessage) => void,
		private readonly callbacks: AccountAuthenticationCallbacks,
	) { }

	/** The account this conversation is about, whether or not it has been proved yet. */
	get accountId(): string {
		return this.keyPair.accountId;
	}

	/**
	 * Starts the conversation by registering the public key.
	 *
	 * Registering every time, rather than remembering whether this account was registered before, is
	 * what lets a participant reconnect to a gateway that has never heard of it: a public key the
	 * gateway already knows is answered with the profile it already holds and changes nothing.
	 */
	begin(): void {
		this.send({
			type: 'account.register',
			signatureAlgorithmName: this.keyPair.signatureAlgorithmName,
			publicKeySpkiBase64: this.keyPair.publicKeySpkiBase64,
		});
	}

	/**
	 * Acts on one message, when it is one this conversation is waiting for.
	 *
	 * @param message The message the connection received.
	 * @returns `true` when the message belonged to this conversation and has been dealt with, so the
	 * caller does not also treat it as one of its own.
	 */
	handleMessage(message: AccountAuthenticationMessage): boolean {
		if (message.type === 'account.registered') {
			this.send({ type: 'account.challenge.request' });
			return true;
		}
		if (message.type === 'account.challenge') {
			void this.signChallenge(message.challenge);
			return true;
		}
		if (message.type === 'account.authenticated') {
			this.settle(message.accountId ?? this.keyPair.accountId);
			return true;
		}
		// An error while the account is still being settled is what the caller is waiting on, so it is
		// reported and the caller released. Once the account is settled, an error belongs to whatever
		// else the connection was doing and is left to it.
		if (message.type === 'error' && this.isSettled === false && AccountAuthentication.isAccountErrorCode(message.code)) {
			this.callbacks.onNote?.(`This gateway would not give this participant an account (${message.code ?? 'no code'}: ${message.message ?? 'no reason given'}). Its work will be recorded against the shared development account.`);
			this.settle(undefined);
			return true;
		}
		return false;
	}

	/**
	 * Signs the value the gateway handed out, and sends the signature.
	 *
	 * @param challenge The value to sign.
	 * @returns Nothing.
	 */
	private async signChallenge(challenge: string | undefined): Promise<void> {
		if (challenge === undefined) {
			this.settle(undefined);
			return;
		}
		try {
			const signatureBase64 = await AccountIdentity.signChallenge(this.keyPair.signatureAlgorithmName, this.keyPair.privateKey, challenge);
			this.send({ type: 'account.authenticate', accountId: this.keyPair.accountId, signatureBase64 });
		} catch (error) {
			const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			this.callbacks.onNote?.(`This participant could not sign the gateway's challenge: ${reason}. Its work will be recorded against the shared development account.`);
			this.settle(undefined);
		}
	}

	/**
	 * Reports the conversation as finished, exactly once.
	 *
	 * @param accountId The account that was proved, or `undefined` when none was.
	 */
	private settle(accountId: string | undefined): void {
		if (this.isSettled) {
			return;
		}
		this.isSettled = true;
		this.callbacks.onSettled(accountId);
	}

	/**
	 * Reports whether one error code belongs to this conversation.
	 *
	 * The list includes the codes a gateway built before accounts existed would answer these messages
	 * with, because that gateway is exactly the case this has to survive.
	 *
	 * @param code The code the gateway sent.
	 * @returns `true` when this conversation is what the error is about.
	 */
	private static isAccountErrorCode(code: string | undefined): boolean {
		return code === undefined || ['ACCOUNT_NOT_FOUND', 'ACCOUNT_CHALLENGE_INVALID', 'ACCOUNT_SIGNATURE_REJECTED', 'ACCOUNT_REQUIRED', 'INVALID_MESSAGE', 'VALIDATION', 'UNSUPPORTED'].includes(code);
	}
}
