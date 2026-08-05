import type { AccountSignatureAlgorithmName } from './account_signature_algorithm.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountKeyPairStore — keeps one account key pair in IndexedDB, across reloads and restarts
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The one record this store holds, exactly as IndexedDB holds it. */
export type StoredAccountKeyPair = {
	/** Which signature algorithm the key pair was generated for. */
	algorithmName: AccountSignatureAlgorithmName;
	/** The public half of the key pair, which may be exported. */
	publicKey: CryptoKey;
	/** The private half of the key pair, which was generated as non-extractable. */
	privateKey: CryptoKey;
	/** When the key pair was generated, as an ISO 8601 timestamp. */
	createdAt: string;
	/** How many page loads have found this key pair already stored. */
	loadCount: number;
};

/**
 * Keeps one account key pair in IndexedDB.
 *
 * The `CryptoKey` objects themselves are stored, not exported key bytes, which is what allows a
 * private key generated as non-extractable to be kept at all: the browser holds the key material
 * and hands back a handle to it, and this page never sees the private key.
 *
 * `loadCount` is what makes persistence measurable rather than assumed. Every page load that
 * finds a stored key pair raises the count and writes it back, so the number on screen says how
 * many loads have reused the same key pair, and `createdAt` says when it was first generated —
 * before or after the browser was last restarted.
 */
export class AccountKeyPairStore {
	/** The IndexedDB database name. */
	static readonly databaseName = 'webai_at_home_account_key_experiment';
	/** The object store name inside that database. */
	static readonly objectStoreName = 'account_key_pair';
	/** The key the single record is stored under. */
	static readonly recordKey = 'account_key_pair';

	/** The open database, once `open` has been awaited. */
	private database: IDBDatabase | undefined;

	/**
	 * Opens the database, creating the object store on first use.
	 *
	 * @returns Nothing. The open database is kept for the calls that follow.
	 */
	async open(): Promise<void> {
		this.database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(AccountKeyPairStore.databaseName, 1);
			request.onupgradeneeded = () => {
				if (request.result.objectStoreNames.contains(AccountKeyPairStore.objectStoreName) === false) {
					request.result.createObjectStore(AccountKeyPairStore.objectStoreName);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open the database'));
		});
	}

	/**
	 * Reads the stored key pair.
	 *
	 * @returns The stored record, or `undefined` when this browser has never stored one.
	 */
	async read(): Promise<StoredAccountKeyPair | undefined> {
		const database = this.required();
		return await new Promise<StoredAccountKeyPair | undefined>((resolve, reject) => {
			const transaction = database.transaction(AccountKeyPairStore.objectStoreName, 'readonly');
			const request = transaction.objectStore(AccountKeyPairStore.objectStoreName).get(AccountKeyPairStore.recordKey);
			request.onsuccess = () => resolve(request.result as StoredAccountKeyPair | undefined);
			request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to read the account key pair'));
		});
	}

	/**
	 * Writes the key pair, replacing whatever was stored before.
	 *
	 * @param record The record to store.
	 * @returns Nothing.
	 */
	async write(record: StoredAccountKeyPair): Promise<void> {
		const database = this.required();
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(AccountKeyPairStore.objectStoreName, 'readwrite');
			const request = transaction.objectStore(AccountKeyPairStore.objectStoreName).put(record, AccountKeyPairStore.recordKey);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to write the account key pair'));
		});
	}

	/**
	 * Deletes the stored key pair, so the next page load generates a new one.
	 *
	 * @returns Nothing.
	 */
	async delete(): Promise<void> {
		const database = this.required();
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(AccountKeyPairStore.objectStoreName, 'readwrite');
			const request = transaction.objectStore(AccountKeyPairStore.objectStoreName).delete(AccountKeyPairStore.recordKey);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to delete the account key pair'));
		});
	}

	/**
	 * Returns the open database, or explains that `open` was not awaited.
	 *
	 * @returns The open database.
	 */
	private required(): IDBDatabase {
		if (this.database === undefined) {
			throw new Error('The account key pair store was used before open() was awaited');
		}
		return this.database;
	}
}
