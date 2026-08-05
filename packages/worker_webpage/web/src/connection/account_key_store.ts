import { AccountIdentity, type AccountCryptoKey, type AccountSignatureAlgorithmName } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountKeyStore — keeps this browser's account key pair, which it cannot read out
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The one record this store holds, exactly as IndexedDB holds it. */
export type StoredAccountKeyPair = {
	/** Which signature algorithm the key pair was generated for. */
	signatureAlgorithmName: AccountSignatureAlgorithmName;
	/** The public half, which is exported and given to the gateway. */
	publicKey: AccountCryptoKey;
	/** The private half, generated as non-extractable, so this page can never read it out. */
	privateKey: AccountCryptoKey;
	/** When the key pair was generated, as an ISO 8601 timestamp. */
	createdAt: string;
};

/** This browser's account key pair, with the public key already written the way a message carries it. */
export type WorkerAccountKeyPair = StoredAccountKeyPair & {
	/** The public key in the `spki` encoding, as base64. */
	publicKeySpkiBase64: string;
	/** The account identifier the public key derives to. */
	accountId: string;
	/** Whether this page load generated the key pair, rather than finding it already stored. */
	isNewlyGenerated: boolean;
};

/** The IndexedDB database this store keeps its one record in. */
const databaseName = 'webai_at_home_worker_account';

/** The object store inside that database. */
const objectStoreName = 'account_key_pair';

/** The key the single record is stored under. */
const recordKey = 'account_key_pair';

/**
 * Keeps this browser's account key pair in IndexedDB, as keys the page itself cannot read out.
 *
 * The `CryptoKey` objects are stored, not exported key bytes, which is what allows the private key to
 * be non-extractable: the browser holds the key material and hands back a handle to it, so this page
 * — and any script that ever runs in it — can sign with the key and can never copy it anywhere.
 * `packages/_account_key_experiments` is where that was proven to work, in Google Chrome, Safari, and
 * the in-app Chromium of Claude Code, before this was written
 * (https://github.com/webai-at-home/webai-at-home/issues/124).
 *
 * Two consequences are worth knowing, and neither is a fault of this code. The key pair belongs to
 * one browser profile on one device, so a volunteer contributing from a laptop and from a phone earns
 * into two accounts. And a browser that has not granted persistent storage may evict the key pair to
 * reclaim space, which loses the account: `navigator.storage.persist()` is asked here, and answered
 * `false` by Safari and by the in-app Chromium in the de-risk gate.
 */
export class AccountKeyStore {
	/**
	 * Reads this browser's key pair, generating and storing one on the first visit.
	 *
	 * @returns The key pair, with its public key and account identifier already worked out.
	 */
	static async loadOrCreate(): Promise<WorkerAccountKeyPair> {
		const database = await AccountKeyStore.openDatabase();
		try {
			await AccountKeyStore.askForPersistentStorage();
			const stored = await AccountKeyStore.read(database);
			if (stored !== undefined) {
				return await AccountKeyStore.describe(stored, false);
			}
			const signatureAlgorithmName = await AccountKeyStore.firstSupportedAlgorithm();
			const keyPair = await AccountIdentity.generateKeyPair(signatureAlgorithmName, false);
			const record: StoredAccountKeyPair = {
				signatureAlgorithmName,
				publicKey: keyPair.publicKey,
				privateKey: keyPair.privateKey,
				createdAt: new Date().toISOString(),
			};
			await AccountKeyStore.write(database, record);
			return await AccountKeyStore.describe(record, true);
		} finally {
			database.close();
		}
	}

	/**
	 * Finds the first signature algorithm this browser will generate a non-extractable key pair for.
	 *
	 * `Ed25519` is what every browser in the de-risk gate chose. A browser that refuses it falls back
	 * to `ECDSA` over `P-256`, which the Web Cryptography API has supported for far longer.
	 *
	 * @returns The algorithm to generate with.
	 * @throws If the browser will generate neither.
	 */
	private static async firstSupportedAlgorithm(): Promise<AccountSignatureAlgorithmName> {
		for (const signatureAlgorithmName of ['Ed25519', 'ECDSA-P-256'] as const) {
			try {
				await AccountIdentity.generateKeyPair(signatureAlgorithmName, false);
				return signatureAlgorithmName;
			} catch {
				continue;
			}
		}
		throw new Error('This browser supports neither Ed25519 nor ECDSA over P-256, so it cannot hold an account');
	}

	/**
	 * Works out everything about a stored key pair that a message needs to carry.
	 *
	 * @param stored The record as IndexedDB holds it.
	 * @param isNewlyGenerated Whether this page load generated it.
	 * @returns The key pair, described.
	 */
	private static async describe(stored: StoredAccountKeyPair, isNewlyGenerated: boolean): Promise<WorkerAccountKeyPair> {
		const publicKeySpkiBase64 = await AccountIdentity.exportPublicKeySpkiBase64(stored.publicKey);
		return {
			...stored,
			publicKeySpkiBase64,
			accountId: await AccountIdentity.accountIdFor(publicKeySpkiBase64),
			isNewlyGenerated,
		};
	}

	/**
	 * Asks the browser not to evict this origin's storage to reclaim space.
	 *
	 * The answer is not acted on: a browser that says no still runs this page, and still earns credits
	 * with it. What is at stake is only whether the account survives the browser needing disk space.
	 *
	 * @returns Nothing.
	 */
	private static async askForPersistentStorage(): Promise<void> {
		try {
			await navigator.storage?.persist?.();
		} catch {
			// A browser that refuses even to be asked changes nothing about what this page does.
		}
	}

	/**
	 * Opens the database, creating the object store on the first visit.
	 *
	 * @returns The open database.
	 */
	private static async openDatabase(): Promise<IDBDatabase> {
		return await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(databaseName, 1);
			request.onupgradeneeded = (): void => {
				if (request.result.objectStoreNames.contains(objectStoreName) === false) {
					request.result.createObjectStore(objectStoreName);
				}
			};
			request.onsuccess = (): void => resolve(request.result);
			request.onerror = (): void => reject(request.error ?? new Error('IndexedDB refused to open the account key pair database'));
		});
	}

	/**
	 * Reads the stored key pair.
	 *
	 * @param database The open database.
	 * @returns The stored record, or `undefined` when this browser has never stored one.
	 */
	private static async read(database: IDBDatabase): Promise<StoredAccountKeyPair | undefined> {
		return await new Promise<StoredAccountKeyPair | undefined>((resolve, reject) => {
			const request = database.transaction(objectStoreName, 'readonly').objectStore(objectStoreName).get(recordKey);
			request.onsuccess = (): void => resolve(request.result as StoredAccountKeyPair | undefined);
			request.onerror = (): void => reject(request.error ?? new Error('IndexedDB refused to read the account key pair'));
		});
	}

	/**
	 * Writes the key pair, replacing whatever was stored before.
	 *
	 * @param database The open database.
	 * @param record The record to store.
	 * @returns Nothing.
	 */
	private static async write(database: IDBDatabase, record: StoredAccountKeyPair): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const request = database.transaction(objectStoreName, 'readwrite').objectStore(objectStoreName).put(record, recordKey);
			request.onsuccess = (): void => resolve();
			request.onerror = (): void => reject(request.error ?? new Error('IndexedDB refused to write the account key pair'));
		});
	}
}
