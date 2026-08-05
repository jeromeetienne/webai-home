import Fs from 'node:fs';
import { AccountProfileSchema, type AccountProfile, type AccountSignatureAlgorithmName } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountRegistry — holds every account the gateway knows, and keeps them on disk
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one participant states about itself when it registers an account. */
export type AccountRegistration = {
	/** The account identifier, already derived from the public key by the caller. */
	accountId: string;
	/** Which signature algorithm the account's key pair uses. */
	signatureAlgorithmName: AccountSignatureAlgorithmName;
	/** The account's public key, in the `spki` encoding, as base64. */
	publicKeySpkiBase64: string;
	/** The email address for the profile, which may be empty. */
	emailAddress: string;
	/** The display name for the profile, which may be empty. */
	displayName: string;
};

/** What registering produced: the profile the gateway now holds, and whether it was just created. */
export type AccountRegistrationResult = {
	/** The profile the gateway holds for this public key. */
	account: AccountProfile;
	/** Whether this registration created the account, rather than finding it already there. */
	isNewAccount: boolean;
};

/** The version of the account file this gateway writes and is willing to read back. */
const accountFileSchemaVersion = 1;

/**
 * Holds every account the gateway knows.
 *
 * An account is permanent: it is created once, by the participant that holds its private key, and
 * from then on it is what a ledger entry is recorded against. This registry therefore keeps the
 * profiles only — the mutable description of who an account belongs to — and holds no balance and
 * no history. Those belong to the ledger, which is append-only and is a separate file for that
 * reason.
 *
 * Registering a public key the gateway already knows returns the stored profile and changes
 * nothing. Registration does not prove that the sender holds the matching private key, so it must
 * not be able to overwrite the email address or display name of an account somebody else owns.
 * Editing a profile needs a session already authenticated as that account, which Version 1 does not
 * offer.
 */
export class AccountRegistry {
	/** The accounts, by account identifier. */
	private readonly accountsByAccountId = new Map<string, AccountProfile>();
	/** The account identifier of each known public key, so a repeat registration is recognised. */
	private readonly accountIdByPublicKey = new Map<string, string>();

	/**
	 * @param accountFilePath Where the accounts are kept. Left out, nothing is written to disk and
	 * every account is forgotten when the gateway stops.
	 * @param now Where the current time is read from. Tests pass their own.
	 */
	constructor(private readonly accountFilePath?: string, private readonly now: () => Date = () => new Date()) {
		this.restore();
	}

	/**
	 * Registers an account, or reports the account this public key already has.
	 *
	 * @param registration What the participant stated about itself.
	 * @returns The stored profile, and whether this call created it.
	 */
	register(registration: AccountRegistration): AccountRegistrationResult {
		const existingAccountId = this.accountIdByPublicKey.get(registration.publicKeySpkiBase64);
		if (existingAccountId !== undefined) {
			const existing = this.accountsByAccountId.get(existingAccountId);
			if (existing !== undefined) {
				return {
					account: existing,
					isNewAccount: false,
				};
			}
		}
		const account: AccountProfile = {
			accountId: registration.accountId,
			signatureAlgorithmName: registration.signatureAlgorithmName,
			publicKeySpkiBase64: registration.publicKeySpkiBase64,
			emailAddress: registration.emailAddress,
			displayName: registration.displayName,
			createdAt: this.now().toISOString(),
		};
		this.accountsByAccountId.set(account.accountId, account);
		this.accountIdByPublicKey.set(account.publicKeySpkiBase64, account.accountId);
		this.persist();
		return {
			account,
			isNewAccount: true,
		};
	}

	/**
	 * Looks up one account.
	 *
	 * @param accountId The account identifier to look up.
	 * @returns The profile, or `undefined` when the gateway knows no such account.
	 */
	get(accountId: string): AccountProfile | undefined {
		return this.accountsByAccountId.get(accountId);
	}

	/** Returns every account the gateway knows. */
	list(): AccountProfile[] {
		return [...this.accountsByAccountId.values()];
	}

	/**
	 * Reads the accounts back from the account file before the gateway accepts traffic.
	 *
	 * An account file this gateway cannot read stops the gateway instead of being ignored. Starting
	 * with an empty registry would hand every returning participant a second account and leave the
	 * ledger recording work against an identifier nobody can authenticate as.
	 *
	 * @returns Nothing.
	 */
	private restore(): void {
		if (this.accountFilePath === undefined || this.accountFilePath === '' || Fs.existsSync(this.accountFilePath) === false) {
			return;
		}
		const document = JSON.parse(Fs.readFileSync(this.accountFilePath, 'utf8')) as { schemaVersion: number; accounts: unknown[] };
		if (document.schemaVersion !== accountFileSchemaVersion || Array.isArray(document.accounts) === false) {
			throw new Error(`Unsupported account file schema in ${this.accountFilePath}`);
		}
		for (const stored of document.accounts) {
			const account = AccountProfileSchema.parse(stored);
			this.accountsByAccountId.set(account.accountId, account);
			this.accountIdByPublicKey.set(account.publicKeySpkiBase64, account.accountId);
		}
	}

	/** Writes through a temporary file so a process interruption cannot leave partial JSON. */
	private persist(): void {
		if (this.accountFilePath === undefined || this.accountFilePath === '') {
			return;
		}
		const temporaryPath = `${this.accountFilePath}.tmp`;
		Fs.writeFileSync(temporaryPath, JSON.stringify({ schemaVersion: accountFileSchemaVersion, accounts: this.list() }), 'utf8');
		Fs.renameSync(temporaryPath, this.accountFilePath);
	}
}
