import { AccountKeyPairStore, type StoredAccountKeyPair } from './account_key_pair_store.js';
import { AccountSignatureAlgorithm, type AccountSignatureAlgorithmCandidate, type AccountSignatureAlgorithmName } from './account_signature_algorithm.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountKeyPairLogPage — the de-risk gate of the accounting system, run in a real browser tab
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One line of the page's log. */
type LogLine = {
	/** What the line is about, shown in its own column. */
	label: string;
	/** What happened, in full. */
	detail: string;
	/** Whether the line reports something the gate requires, something optional, or a failure. */
	verdict: 'pass' | 'fail' | 'information';
};

/**
 * Every log line of one page load, posted whether the page succeeded or failed.
 *
 * This exists so that a browser which could not generate or store a key pair at all is told apart
 * from a browser that never opened the page: the first leaves a run report full of failures, the
 * second leaves nothing.
 */
type AccountKeyPairRunReport = {
	/** The browser the page ran in. */
	userAgent: string;
	/** Whether the page had the secure context the Web Cryptography API needs. */
	isSecureContext: boolean;
	/** When the run finished, as an ISO 8601 timestamp. */
	finishedAt: string;
	/** Whether every line the gate requires reported a pass, and none reported a failure. */
	isPassed: boolean;
	/** Every log line the page wrote, in order. */
	logLines: LogLine[];
};

/**
 * Everything the Node.js verification script needs, and nothing that is secret.
 *
 * The private key never appears here, and cannot: it was generated as non-extractable, so the
 * browser refuses to hand it over. What the script receives is the public key, the challenge, and
 * the signature, which is exactly what the gateway would receive.
 */
type AccountKeySignatureDocument = {
	/** Which signature algorithm produced the signature. */
	algorithmName: AccountSignatureAlgorithmName;
	/** The browser that produced it, so a result can be attributed to one browser. */
	userAgent: string;
	/** When the key pair was generated, as an ISO 8601 timestamp. */
	keyPairCreatedAt: string;
	/** How many page loads had found the key pair already stored when it signed. */
	keyPairLoadCount: number;
	/** The public key in the `spki` encoding, as base64. Every browser and Node.js accept this one. */
	publicKeySpkiBase64: string;
	/** The public key in the `raw` encoding, as base64, or an empty string when the browser refused. */
	publicKeyRawBase64: string;
	/** The challenge that was signed, as lower-case hexadecimal. */
	challengeHex: string;
	/** The exact text the challenge was signed inside, so the script can rebuild and compare it. */
	signedMessage: string;
	/** The signature, as base64. */
	signatureBase64: string;
	/** When the signature was produced, as an ISO 8601 timestamp. */
	signedAt: string;
};

/**
 * The de-risk gate of the accounting system recorded in issue #122, run in a real browser tab.
 *
 * The page answers one question: can a worker browser tab generate a key pair whose private key
 * cannot be read back out, keep that key pair across page reloads and browser restarts, and sign
 * a value the gateway sends it, with a signature the gateway's Node.js process can verify?
 *
 * The page proves the first three parts on its own. The fourth is proven by handing the document
 * this page prints to `tools/verify_account_key_signature.js`, which runs in Node.js and holds no
 * browser code at all.
 */
class AccountKeyPairLogPage {
	/** Where the log lines are written. */
	private readonly logElement: HTMLElement;
	/** Where the verification document is written. */
	private readonly documentElement: HTMLElement;
	/** The key pair store, opened once at start-up. */
	private readonly store = new AccountKeyPairStore();
	/** The stored key pair, once it has been read back or generated. */
	private keyPair: StoredAccountKeyPair | undefined;
	/** The algorithm the stored key pair uses. */
	private candidate: AccountSignatureAlgorithmCandidate | undefined;
	/** Every log line written so far, kept so the whole run can be posted as one report. */
	private readonly logLines: LogLine[] = [];

	/**
	 * @param logElement Where the log lines are written.
	 * @param documentElement Where the verification document is written.
	 */
	constructor(logElement: HTMLElement, documentElement: HTMLElement) {
		this.logElement = logElement;
		this.documentElement = documentElement;
	}

	/**
	 * Runs the gate and posts the run report afterwards, whatever happened.
	 *
	 * Anything thrown along the way is written into the log as a failure rather than left to the
	 * console, because a browser that cannot run this page at all is exactly the result worth
	 * recording.
	 *
	 * @returns Nothing.
	 */
	async run(): Promise<void> {
		try {
			await this.runGate();
		} catch (error) {
			this.log('run', `The page stopped with an error: ${AccountSignatureAlgorithm.messageOf(error)}`, 'fail');
		}
		await this.sendRunReport();
	}

	/**
	 * Runs the whole gate: report the environment, probe both algorithms, read back or generate
	 * the key pair, check that the private key still cannot be exported, and sign a challenge.
	 *
	 * @returns Nothing.
	 */
	private async runGate(): Promise<void> {
		this.log('user agent', navigator.userAgent, 'information');
		this.log('secure context', String(window.isSecureContext), window.isSecureContext ? 'pass' : 'fail');
		if (window.isSecureContext === false) {
			this.log('gate', 'The Web Cryptography API needs a secure context. Open this page over localhost or HTTPS.', 'fail');
			return;
		}
		await this.reportStoragePersistence();

		for (const candidate of AccountSignatureAlgorithm.candidates) {
			const probe = await AccountSignatureAlgorithm.probe(candidate);
			this.log(`algorithm ${probe.name}`, probe.detail, probe.isSupported ? 'pass' : 'fail');
		}

		await this.store.open();
		await this.loadOrCreateKeyPair();
		await this.reportPrivateKeyExportRefusal();
		await this.signFreshChallenge();
	}

	/**
	 * Signs a newly generated random challenge and prints the verification document.
	 *
	 * @returns Nothing.
	 */
	async signFreshChallenge(): Promise<void> {
		const keyPair = this.keyPair;
		const candidate = this.candidate;
		if (keyPair === undefined || candidate === undefined) {
			this.log('signature', 'There is no key pair to sign with.', 'fail');
			return;
		}
		const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
		const challengeHex = AccountKeyPairLogPage.hexOf(challengeBytes);
		const signedMessageBytes = AccountSignatureAlgorithm.signedMessageBytesFor(challengeHex);
		let signature: ArrayBuffer;
		try {
			signature = await crypto.subtle.sign(candidate.signatureAlgorithm, keyPair.privateKey, signedMessageBytes);
		} catch (error) {
			this.log('signature', `sign was refused: ${AccountSignatureAlgorithm.messageOf(error)}`, 'fail');
			return;
		}
		const isVerifiedInThisBrowser = await crypto.subtle.verify(candidate.signatureAlgorithm, keyPair.publicKey, signature, signedMessageBytes);
		this.log('signature', `${signature.byteLength} bytes, verified by this same browser: ${String(isVerifiedInThisBrowser)}`, isVerifiedInThisBrowser ? 'pass' : 'fail');

		const signatureDocument: AccountKeySignatureDocument = {
			algorithmName: keyPair.algorithmName,
			userAgent: navigator.userAgent,
			keyPairCreatedAt: keyPair.createdAt,
			keyPairLoadCount: keyPair.loadCount,
			publicKeySpkiBase64: AccountKeyPairLogPage.base64Of(await crypto.subtle.exportKey('spki', keyPair.publicKey)),
			publicKeyRawBase64: await this.rawPublicKeyBase64Of(keyPair.publicKey),
			challengeHex,
			signedMessage: `${AccountSignatureAlgorithm.signedMessagePrefix}${challengeHex}`,
			signatureBase64: AccountKeyPairLogPage.base64Of(signature),
			signedAt: new Date().toISOString(),
		};
		this.documentElement.textContent = JSON.stringify(signatureDocument, undefined, '\t');
		console.log('account_key_pair_log verification_document', JSON.stringify(signatureDocument));
		this.log('verification document', 'Printed below, and written to the browser console.', 'information');
		await this.sendToVerificationDocumentCollector(signatureDocument);
	}

	/**
	 * Posts every log line of this page load to the development server, which writes it into
	 * `run_reports/`.
	 *
	 * @returns Nothing.
	 */
	private async sendRunReport(): Promise<void> {
		const runReport: AccountKeyPairRunReport = {
			userAgent: navigator.userAgent,
			isSecureContext: window.isSecureContext,
			finishedAt: new Date().toISOString(),
			isPassed: this.logLines.some((line) => line.verdict === 'fail') === false && this.logLines.some((line) => line.verdict === 'pass'),
			logLines: this.logLines,
		};
		console.log('account_key_pair_log run_report', JSON.stringify(runReport));
		try {
			const response = await fetch('/run_report', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
				},
				body: JSON.stringify(runReport),
			});
			if (response.ok === false) {
				this.log('run report', `The development server refused it with status ${String(response.status)}`, 'information');
				return;
			}
			const collected = await response.json() as { fileName: string };
			this.log('run report', `Written to run_reports/${collected.fileName}`, 'information');
		} catch (error) {
			this.log('run report', `Could not be posted: ${AccountSignatureAlgorithm.messageOf(error)}`, 'information');
		}
	}

	/**
	 * Posts the verification document to the development server, which writes it into
	 * `verification_documents/`.
	 *
	 * This exists so that a browser this machine cannot script — Safari, Firefox, or a phone on the
	 * same network — still leaves its result on disk, instead of that result having to be copied
	 * out of the browser's console by hand.
	 *
	 * @param signatureDocument The document to post.
	 * @returns Nothing.
	 */
	private async sendToVerificationDocumentCollector(signatureDocument: AccountKeySignatureDocument): Promise<void> {
		try {
			const response = await fetch('/verification_document', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
				},
				body: JSON.stringify(signatureDocument),
			});
			if (response.ok === false) {
				this.log('document collected', `The development server refused it with status ${String(response.status)}: ${await response.text()}`, 'information');
				return;
			}
			const collected = await response.json() as { fileName: string };
			this.log('document collected', `Written to verification_documents/${collected.fileName}`, 'pass');
		} catch (error) {
			this.log('document collected', `Could not be posted, so copy it out of the console by hand: ${AccountSignatureAlgorithm.messageOf(error)}`, 'information');
		}
	}

	/**
	 * Deletes the stored key pair and reloads, so the next load generates a new one.
	 *
	 * @returns Nothing.
	 */
	async deleteStoredKeyPair(): Promise<void> {
		await this.store.delete();
		this.log('stored key pair', 'Deleted. Reloading, which generates a new key pair.', 'information');
		location.reload();
	}

	/**
	 * Reads the key pair back from IndexedDB, or generates and stores one on first visit.
	 *
	 * @returns Nothing.
	 */
	private async loadOrCreateKeyPair(): Promise<void> {
		const stored = await this.store.read();
		if (stored !== undefined) {
			const candidate = AccountSignatureAlgorithm.candidateByName(stored.algorithmName);
			if (candidate === undefined) {
				this.log('stored key pair', `The stored key pair names an algorithm this page does not know: ${stored.algorithmName}`, 'fail');
				return;
			}
			const reloaded: StoredAccountKeyPair = { ...stored, loadCount: stored.loadCount + 1 };
			await this.store.write(reloaded);
			this.keyPair = reloaded;
			this.candidate = candidate;
			this.log('stored key pair', `Read back from IndexedDB. Algorithm ${reloaded.algorithmName}, generated at ${reloaded.createdAt}, found by ${reloaded.loadCount} page load(s) since.`, 'pass');
			this.log('private key handle', `extractable: ${String(reloaded.privateKey.extractable)}, usages: ${reloaded.privateKey.usages.join(', ')}`, reloaded.privateKey.extractable === false ? 'pass' : 'fail');
			return;
		}

		const candidate = await this.firstSupportedCandidate();
		if (candidate === undefined) {
			this.log('key pair', 'This browser supports neither Ed25519 nor ECDSA over P-256 with a non-extractable private key.', 'fail');
			return;
		}
		const generated = await crypto.subtle.generateKey(candidate.keyAlgorithm, false, ['sign', 'verify']) as CryptoKeyPair;
		const record: StoredAccountKeyPair = {
			algorithmName: candidate.name,
			publicKey: generated.publicKey,
			privateKey: generated.privateKey,
			createdAt: new Date().toISOString(),
			loadCount: 0,
		};
		await this.store.write(record);
		this.keyPair = record;
		this.candidate = candidate;
		this.log('key pair', `No key pair was stored, so one was generated with ${candidate.name} and written to IndexedDB. Reload the page, and restart the browser, to see it read back.`, 'information');
	}

	/**
	 * Checks that the private key read back out of IndexedDB still cannot be exported.
	 *
	 * A key pair that survives storage but comes back extractable would defeat the point, so the
	 * refusal is checked on the handle that came out of the database rather than only on the
	 * freshly generated one.
	 *
	 * @returns Nothing.
	 */
	private async reportPrivateKeyExportRefusal(): Promise<void> {
		const keyPair = this.keyPair;
		if (keyPair === undefined) {
			return;
		}
		try {
			await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
			this.log('private key export', 'The browser exported the stored private key, which this gate does not accept.', 'fail');
		} catch (error) {
			this.log('private key export', `Refused, as required: ${AccountSignatureAlgorithm.messageOf(error)}`, 'pass');
		}
	}

	/**
	 * Reports whether this browser has promised not to evict the stored key pair to reclaim space.
	 *
	 * This is reported rather than required. A browser that has not granted persistent storage may
	 * discard the key pair, which for a real account means the account is lost, and that is a
	 * finding for the plan rather than a failure of the gate.
	 *
	 * @returns Nothing.
	 */
	private async reportStoragePersistence(): Promise<void> {
		if (navigator.storage === undefined || navigator.storage.persisted === undefined) {
			this.log('storage persistence', 'This browser has no navigator.storage.persisted, so eviction cannot be asked about.', 'information');
			return;
		}
		const isPersistedBefore = await navigator.storage.persisted();
		const isPersistedAfter = navigator.storage.persist === undefined ? isPersistedBefore : await navigator.storage.persist();
		this.log('storage persistence', `persisted() before asking: ${String(isPersistedBefore)}, after asking persist(): ${String(isPersistedAfter)}`, 'information');
	}

	/**
	 * Finds the first algorithm this browser supports, in this page's order of preference.
	 *
	 * @returns The algorithm to generate with, or `undefined` when neither is supported.
	 */
	private async firstSupportedCandidate(): Promise<AccountSignatureAlgorithmCandidate | undefined> {
		for (const candidate of AccountSignatureAlgorithm.candidates) {
			const probe = await AccountSignatureAlgorithm.probe(candidate);
			if (probe.isSupported) {
				return candidate;
			}
		}
		return undefined;
	}

	/**
	 * Exports the public key in the `raw` encoding, which not every browser offers for every
	 * algorithm.
	 *
	 * @param publicKey The public key to export.
	 * @returns The key as base64, or an empty string when the browser refused.
	 */
	private async rawPublicKeyBase64Of(publicKey: CryptoKey): Promise<string> {
		try {
			return AccountKeyPairLogPage.base64Of(await crypto.subtle.exportKey('raw', publicKey));
		} catch (error) {
			this.log('raw public key export', `Refused: ${AccountSignatureAlgorithm.messageOf(error)}. The spki encoding is used instead.`, 'information');
			return '';
		}
	}

	/**
	 * Writes one line to the page and to the browser console.
	 *
	 * @param label What the line is about.
	 * @param detail What happened.
	 * @param verdict Whether it passes, fails, or is only information.
	 */
	private log(label: string, detail: string, verdict: LogLine['verdict']): void {
		const line: LogLine = { label, detail, verdict };
		this.logLines.push(line);
		const row = document.createElement('div');
		row.className = `log-row verdict-${line.verdict}`;
		const labelElement = document.createElement('span');
		labelElement.className = 'log-label';
		labelElement.textContent = line.label;
		const detailElement = document.createElement('span');
		detailElement.className = 'log-detail';
		detailElement.textContent = line.detail;
		row.append(labelElement, detailElement);
		this.logElement.append(row);
		console.log(`account_key_pair_log [${line.verdict}] ${line.label}: ${line.detail}`);
	}

	/**
	 * Writes bytes as lower-case hexadecimal.
	 *
	 * @param bytes The bytes to write.
	 * @returns The hexadecimal text.
	 */
	private static hexOf(bytes: Uint8Array): string {
		return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * Writes bytes as base64.
	 *
	 * @param buffer The bytes to write.
	 * @returns The base64 text.
	 */
	private static base64Of(buffer: ArrayBuffer): string {
		return btoa(String.fromCharCode(...new Uint8Array(buffer)));
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Page start-up
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const logElement = document.querySelector('#log');
const documentElement = document.querySelector('#verification-document');
const signButton = document.querySelector('#sign-again');
const deleteButton = document.querySelector('#delete-key-pair');
if (logElement instanceof HTMLElement && documentElement instanceof HTMLElement && signButton instanceof HTMLButtonElement && deleteButton instanceof HTMLButtonElement) {
	const page = new AccountKeyPairLogPage(logElement, documentElement);
	signButton.addEventListener('click', () => {
		void page.signFreshChallenge();
	});
	deleteButton.addEventListener('click', () => {
		void page.deleteStoredKeyPair();
	});
	void page.run();
}
