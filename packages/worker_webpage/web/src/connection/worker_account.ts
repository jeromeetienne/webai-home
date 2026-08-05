import { AccountIdentity, type AccountLedgerSummary, type ClientMessage } from '@webai/protocol';
import { AccountKeyStore, type WorkerAccountKeyPair } from './account_key_store';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerAccount — proves which account this browser is, and follows what it earns
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The account messages and answers this class recognises, as this page reads them off a frame. */
export type AccountGatewayMessage = {
	/** The message category. */
	type: string;
	/** The profile, on `account.registered`. */
	account?: { accountId: string };
	/** Whether registering created the account, on `account.registered`. */
	isNewAccount?: boolean;
	/** The value to sign, on `account.challenge`. */
	challenge?: string;
	/** The account now on the connection, on `account.authenticated`. */
	accountId?: string;
	/** What this account's entries add up to, on `account.balance`. */
	summary?: AccountLedgerSummary;
	/** The error code, on `error`. */
	code?: string;
	/** What the gateway said, on `error`. */
	message?: string;
};

/** What this class reports back to the page as the account conversation proceeds. */
export type WorkerAccountCallbacks = {
	/** Called once the account is proved, or once it is clear it will not be. */
	onSettled: (accountId: string | undefined) => void;
	/** Called with the account identifier as soon as it is known, before it is proved. */
	onAccountKnown: (accountId: string) => void;
	/** Called every time the gateway reports what this account holds. */
	onBalance: (summary: AccountLedgerSummary) => void;
	/** Called with something worth showing the volunteer, whether it went well or not. */
	onNote: (note: string) => void;
};

/**
 * Proves which account this browser is, and asks the gateway what that account holds.
 *
 * The conversation is three messages: register the public key, ask for a value to sign, and send the
 * signature. It is kept out of the page's own class because it is a sequence with its own state, and
 * because the page has one job — running assigned stages — that this must not complicate.
 *
 * The page waits for `onSettled` before it registers as a worker, so no stage can ever complete
 * before the gateway knows whose account earned it. `onSettled` is called with no account when the
 * gateway will not have one — an older gateway that does not know these messages, or a browser that
 * cannot hold a key pair — because a volunteer contributing anonymously is far better than a page
 * that refuses to contribute at all.
 */
export class WorkerAccount {
	/** This browser's key pair, once it has been read out of IndexedDB. */
	private keyPair: WorkerAccountKeyPair | undefined;
	/** Whether the account conversation has already finished, one way or the other. */
	private isSettled = false;

	/**
	 * @param send How to send one message to the gateway.
	 * @param callbacks What to report back as the conversation proceeds.
	 */
	constructor(private readonly send: (message: ClientMessage) => void, private readonly callbacks: WorkerAccountCallbacks) { }

	/** The account this browser is, once it has been proved. */
	get accountId(): string | undefined {
		return this.keyPair?.accountId;
	}

	/**
	 * Starts the conversation: read or generate the key pair, then register its public key.
	 *
	 * @returns Nothing.
	 */
	async begin(): Promise<void> {
		try {
			this.keyPair = await AccountKeyStore.loadOrCreate();
		} catch (error) {
			this.callbacks.onNote(`This browser cannot hold an account: ${WorkerAccount.messageOf(error)}. It will still run stages, credited to nobody.`);
			this.settle(undefined);
			return;
		}
		this.callbacks.onAccountKnown(this.keyPair.accountId);
		this.callbacks.onNote(this.keyPair.isNewlyGenerated
			? `A new account key pair was generated in this browser and stored in it, using ${this.keyPair.signatureAlgorithmName}.`
			: `This browser's account key pair was read back from its own storage, generated at ${this.keyPair.createdAt}.`);
		this.send({
			type: 'account.register',
			signatureAlgorithmName: this.keyPair.signatureAlgorithmName,
			publicKeySpkiBase64: this.keyPair.publicKeySpkiBase64,
		});
	}

	/**
	 * Acts on one message from the gateway, when it is one this conversation is waiting for.
	 *
	 * @param message The message as this page read it off the frame.
	 * @returns `true` when the message belonged to this conversation and has been dealt with.
	 */
	handleMessage(message: AccountGatewayMessage): boolean {
		if (message.type === 'account.registered') {
			this.send({ type: 'account.challenge.request' });
			return true;
		}
		if (message.type === 'account.challenge') {
			void this.signChallenge(message.challenge);
			return true;
		}
		if (message.type === 'account.authenticated') {
			this.callbacks.onNote(`This browser is authenticated as its own account, so the stages it completes earn credits for it.`);
			this.settle(message.accountId);
			this.requestBalance();
			return true;
		}
		if (message.type === 'account.balance' && message.summary !== undefined) {
			this.callbacks.onBalance(message.summary);
			return true;
		}
		// An error while the account is still being settled is what the page is waiting on, so it is
		// reported and the page is released to register and contribute anyway. Once the account is
		// settled, an error belongs to whatever else the page was doing and is left to it.
		if (message.type === 'error' && this.isSettled === false && WorkerAccount.isAccountErrorCode(message.code)) {
			this.callbacks.onNote(`This gateway would not give this browser an account (${message.code ?? 'no code'}: ${message.message ?? 'no reason given'}). It will still run stages, credited to nobody.`);
			this.settle(undefined);
			return true;
		}
		return false;
	}

	/**
	 * Asks the gateway what this account holds.
	 *
	 * @returns Nothing.
	 */
	requestBalance(): void {
		if (this.keyPair === undefined) {
			return;
		}
		this.send({ type: 'account.balance.get' });
	}

	/**
	 * Signs the value the gateway handed out, and sends the signature.
	 *
	 * @param challenge The value to sign.
	 * @returns Nothing.
	 */
	private async signChallenge(challenge: string | undefined): Promise<void> {
		const keyPair = this.keyPair;
		if (keyPair === undefined || challenge === undefined) {
			this.settle(undefined);
			return;
		}
		try {
			const signatureBase64 = await AccountIdentity.signChallenge(keyPair.signatureAlgorithmName, keyPair.privateKey, challenge);
			this.send({ type: 'account.authenticate', accountId: keyPair.accountId, signatureBase64 });
		} catch (error) {
			this.callbacks.onNote(`This browser could not sign the gateway's challenge: ${WorkerAccount.messageOf(error)}. It will still run stages, credited to nobody.`);
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
	 * Reports whether one error code belongs to the account conversation.
	 *
	 * @param code The code the gateway sent.
	 * @returns `true` when this conversation is what the error is about.
	 */
	private static isAccountErrorCode(code: string | undefined): boolean {
		return code === undefined || ['ACCOUNT_NOT_FOUND', 'ACCOUNT_CHALLENGE_INVALID', 'ACCOUNT_SIGNATURE_REJECTED', 'ACCOUNT_REQUIRED', 'INVALID_MESSAGE', 'VALIDATION', 'UNSUPPORTED'].includes(code);
	}

	/**
	 * Reads the message out of something that was thrown.
	 *
	 * @param error Whatever was thrown.
	 * @returns The words to show.
	 */
	private static messageOf(error: unknown): string {
		return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	}
}
