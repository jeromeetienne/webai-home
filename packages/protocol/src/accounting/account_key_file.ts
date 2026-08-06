import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import type { AccountKeyPair } from './account_authentication.js';
import { AccountIdentity, type AccountCryptoKey, type AccountKeyJsonWebKey } from './account_identity.js';
import type { AccountSignatureAlgorithmName } from './account_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountKeyFile — keeps this participant's account key pair in one file
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The file's contents, exactly as they are written. */
export type StoredAccountKey = {
	/** The version of this file's shape, so a later change can recognise what it is reading. */
	schemaVersion: number;
	/** Which signature algorithm this key pair uses. */
	signatureAlgorithmName: AccountSignatureAlgorithmName;
	/** The account identifier, derived from the public key and written down for convenience. */
	accountId: string;
	/** The public key, in the `spki` encoding, as base64. This is what the gateway is given. */
	publicKeySpkiBase64: string;
	/** The private key. This is the secret the whole file exists to keep. */
	privateKeyJsonWebKey: AccountKeyJsonWebKey;
	/** When the key pair was generated, as an ISO 8601 timestamp. */
	createdAt: string;
};

/** A key pair read back from the file, with the private key ready to sign. */
export type LoadedAccountKey = {
	/** What the file said. */
	stored: StoredAccountKey;
	/** The private key, imported and able to sign a challenge. */
	privateKey: AccountCryptoKey;
};

/** The version of the key file this program writes and is willing to read back. */
const accountKeyFileSchemaVersion = 1;

/**
 * Keeps this participant's account key pair in one file under the user's home directory.
 *
 * The private key here is the whole account. Anyone holding this file can authenticate as the
 * account and spend whatever it has earned, and losing the file loses the account, because an
 * account identifier is a digest of its own public key and nothing else can produce it again. That
 * is why the file is written readable and writable by its owner only, and why generating a key pair
 * refuses to overwrite an existing one unless it is explicitly told to.
 *
 * A browser page keeps a private key it cannot export, which is stronger. A program that ends and
 * starts again cannot: it has to be the same account on its next run, and a process that has ended
 * holds nothing.
 *
 * This is the one definition of that file, used by `consumer_cli`, by the OpenAI-compatible server,
 * and by the Node.js worker. It reads and writes files, so unlike everything else in this package it
 * cannot run in a browser, which is why it is reached through the `@webai/protocol/account_key_file`
 * subpath and is not exported from this package's main entry point.
 */
export class AccountKeyFile {
	/** Where the key pair is kept when no other path is given. */
	static defaultFilePath(): string {
		return Path.join(Os.homedir(), '.webai-at-home', 'account_key.json');
	}

	/**
	 * Generates a key pair and writes it out.
	 *
	 * @param filePath Where to write it.
	 * @param isForced Whether to overwrite a key pair that is already there. Overwriting one loses
	 * the account it belonged to, so this must be asked for explicitly.
	 * @returns What was written.
	 * @throws {Error} If a key pair is already there and overwriting was not asked for.
	 */
	static async create(filePath: string, isForced: boolean): Promise<StoredAccountKey> {
		if (isForced === false && Fs.existsSync(filePath)) {
			throw new Error(`A key pair is already kept at ${filePath}. Overwriting it loses the account it belongs to, along with whatever that account has earned. Pass --force to overwrite it anyway.`);
		}
		const signatureAlgorithmName: AccountSignatureAlgorithmName = 'Ed25519';
		const keyPair = await AccountIdentity.generateKeyPair(signatureAlgorithmName, true);
		const publicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(keyPair.publicKey);
		const stored: StoredAccountKey = {
			schemaVersion: accountKeyFileSchemaVersion,
			signatureAlgorithmName,
			accountId: await AccountIdentity.accountIdFor(publicKeySpkiBase64),
			publicKeySpkiBase64,
			privateKeyJsonWebKey: await AccountIdentity.exportPrivateKeyJsonWebKey(keyPair.privateKey),
			createdAt: new Date().toISOString(),
		};
		Fs.mkdirSync(Path.dirname(filePath), { recursive: true, mode: 0o700 });
		Fs.writeFileSync(filePath, `${JSON.stringify(stored, undefined, '\t')}\n`, { encoding: 'utf8', mode: 0o600 });
		// A file that already existed keeps the permissions it had, which writeFileSync's mode does not
		// change, so they are set here as well.
		Fs.chmodSync(filePath, 0o600);
		return stored;
	}

	/**
	 * Reads the key pair back when there is one, and reports that there is none when there is not.
	 *
	 * This is what a command that works with or without an account uses. `submit` is the example: a
	 * volunteer who has never run `account_key` still submits tasks, and the stages those tasks run
	 * are recorded against the shared development account rather than the command failing.
	 *
	 * @param filePath Where the key pair would be kept.
	 * @returns The key pair as the account conversation needs it, or `undefined` when there is no key
	 * pair at that path.
	 */
	static async readIfPresent(filePath: string): Promise<AccountKeyPair | undefined> {
		if (Fs.existsSync(filePath) === false) {
			return undefined;
		}
		const loaded = await AccountKeyFile.read(filePath);
		return {
			signatureAlgorithmName: loaded.stored.signatureAlgorithmName,
			publicKeySpkiBase64: loaded.stored.publicKeySpkiBase64,
			accountId: loaded.stored.accountId,
			privateKey: loaded.privateKey,
		};
	}

	/**
	 * Reads the key pair back, with the private key ready to sign.
	 *
	 * @param filePath Where the key pair is kept.
	 * @returns The stored record and the imported private key.
	 * @throws {Error} If there is no key pair there, or the file is not one this program wrote.
	 */
	static async read(filePath: string): Promise<LoadedAccountKey> {
		if (Fs.existsSync(filePath) === false) {
			throw new Error(`No account key pair is kept at ${filePath}. Run "consumer_cli account_key" to generate one.`);
		}
		const stored = JSON.parse(Fs.readFileSync(filePath, 'utf8')) as StoredAccountKey;
		if (stored.schemaVersion !== accountKeyFileSchemaVersion) {
			throw new Error(`The account key pair at ${filePath} states schema version ${String(stored.schemaVersion)}, which this program cannot read`);
		}
		return {
			stored,
			privateKey: await AccountIdentity.importPrivateKeyJsonWebKey(stored.signatureAlgorithmName, stored.privateKeyJsonWebKey),
		};
	}
}
