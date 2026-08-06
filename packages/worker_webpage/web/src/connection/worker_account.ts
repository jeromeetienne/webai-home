import { AccountAuthentication, type AccountLedgerSummary, type ClientMessage } from '@webai/protocol';
import { AccountKeyStore, type WorkerAccountKeyPair } from './account_key_store';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerAccount — this browser's account, and what it earns
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The messages this class reads, as this page takes them off a frame. */
export type AccountGatewayMessage = {
	/** The message category. */
	type: string;
	/** The value to sign, on `account.challenge`. */
	challenge?: string | undefined;
	/** The account now on the connection, on `account.authenticated`. */
	accountId?: string | undefined;
	/** What this account's entries add up to, on `account.balance`. */
	summary?: AccountLedgerSummary | undefined;
	/** The error code, on `error`. */
	code?: string | undefined;
	/** What the gateway said, on `error`. */
	message?: string | undefined;
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
 * This browser's account: where its key pair comes from, and what the gateway says it holds.
 *
 * The three-message conversation that proves the account is not written here. It is
 * `AccountAuthentication` in the shared protocol package, which every participant uses — this page,
 * the consumer command line program, the OpenAI-compatible server, and the Node.js worker — so none
 * of the four can drift away from the others. What is written here is what only a browser page has:
 * a key pair it cannot read out, and a volunteer to show the result to.
 *
 * The page waits for `onSettled` before it registers as a worker, so no stage can complete before the
 * gateway knows whose account earned it. `onSettled` reports no account when the gateway will not
 * give one, or when this browser cannot hold a key pair, because a volunteer contributing anonymously
 * is far better than a page that refuses to contribute at all.
 */
export class WorkerAccount {
	/** This browser's key pair, once it has been read out of IndexedDB. */
	private keyPair: WorkerAccountKeyPair | undefined;
	/** The shared conversation, once the key pair it needs has been read. */
	private authentication: AccountAuthentication | undefined;

	/**
	 * @param send How to send one message to the gateway.
	 * @param callbacks What to report back as the conversation proceeds.
	 */
	constructor(private readonly send: (message: ClientMessage) => void, private readonly callbacks: WorkerAccountCallbacks) { }

	/** The account this browser is, once its key pair has been read. */
	get accountId(): string | undefined {
		return this.keyPair?.accountId;
	}

	/**
	 * Reads or generates this browser's key pair, then starts the conversation that proves it.
	 *
	 * @returns Nothing.
	 */
	async begin(): Promise<void> {
		try {
			this.keyPair = await AccountKeyStore.loadOrCreate();
		} catch (error) {
			const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			this.callbacks.onNote(`This browser cannot hold an account: ${reason}. It will still run stages, credited to nobody.`);
			this.callbacks.onSettled(undefined);
			return;
		}
		this.callbacks.onAccountKnown(this.keyPair.accountId);
		this.callbacks.onNote(this.keyPair.isNewlyGenerated
			? `A new account key pair was generated in this browser and stored in it, using ${this.keyPair.signatureAlgorithmName}.`
			: `This browser's account key pair was read back from its own storage, generated at ${this.keyPair.createdAt}.`);
		this.authentication = new AccountAuthentication(this.keyPair, this.send, {
			onSettled: (accountId: string | undefined): void => {
				if (accountId !== undefined) {
					this.callbacks.onNote('This browser is authenticated as its own account, so the stages it completes earn credits for it.');
					this.requestBalance();
				}
				this.callbacks.onSettled(accountId);
			},
			onNote: this.callbacks.onNote,
		});
		this.authentication.begin();
	}

	/**
	 * Acts on one message from the gateway, when it is one this class is waiting for.
	 *
	 * @param message The message as this page read it off the frame.
	 * @returns `true` when the message belonged here and has been dealt with.
	 */
	handleMessage(message: AccountGatewayMessage): boolean {
		if (message.type === 'account.balance' && message.summary !== undefined) {
			this.callbacks.onBalance(message.summary);
			return true;
		}
		return this.authentication?.handleMessage(message) === true;
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
}
