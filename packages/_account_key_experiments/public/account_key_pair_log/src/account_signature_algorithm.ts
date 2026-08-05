///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountSignatureAlgorithm — the signature algorithms an account key pair may use
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The name of one signature algorithm an account key pair may use. */
export type AccountSignatureAlgorithmName = 'Ed25519' | 'ECDSA-P-256';

/** One signature algorithm an account key pair may use, with everything needed to use it. */
export type AccountSignatureAlgorithmCandidate = {
	/** The name written into the log and into the verification document. */
	name: AccountSignatureAlgorithmName;
	/** The algorithm passed to `generateKey` and to `importKey`. */
	keyAlgorithm: EcKeyGenParams | Algorithm;
	/** The algorithm passed to `sign` and to `verify`. */
	signatureAlgorithm: EcdsaParams | Algorithm;
};

/** What probing one signature algorithm in this browser found. */
export type AccountSignatureAlgorithmProbe = {
	/** The algorithm that was probed. */
	name: AccountSignatureAlgorithmName;
	/** Whether this browser generated a key pair whose private key it refuses to export. */
	isSupported: boolean;
	/** What the browser reported, whether it succeeded or refused. */
	detail: string;
};

/**
 * The signature algorithms an account key pair may use, and what is signed with them.
 *
 * The two algorithms are listed in the order this experiment prefers them. `Ed25519` is
 * preferred because its keys and signatures are small and it needs no separate hash choice.
 * `ECDSA` over the `P-256` curve is the fallback, because the Web Cryptography API has
 * supported it for far longer than it has supported `Ed25519`.
 */
export class AccountSignatureAlgorithm {
	/** The algorithms this experiment tries, most preferred first. */
	static readonly candidates: readonly AccountSignatureAlgorithmCandidate[] = [
		{
			name: 'Ed25519',
			keyAlgorithm: {
				name: 'Ed25519',
			},
			signatureAlgorithm: {
				name: 'Ed25519',
			},
		},
		{
			name: 'ECDSA-P-256',
			keyAlgorithm: {
				name: 'ECDSA',
				namedCurve: 'P-256',
			},
			signatureAlgorithm: {
				name: 'ECDSA',
				hash: 'SHA-256',
			},
		},
	];

	/**
	 * What is signed, before the challenge itself.
	 *
	 * The challenge is signed inside a message that names this project, this purpose, and this
	 * version, so that a signature produced for account authentication cannot be presented as a
	 * signature over something else the same key pair might one day be asked to sign.
	 */
	static readonly signedMessagePrefix = 'webai-at-home:account-authentication:v1:';

	/**
	 * Builds the bytes that are signed for one challenge.
	 *
	 * @param challengeHex The challenge the gateway handed out, as lower-case hexadecimal.
	 * @returns The bytes to sign, held in a plain `ArrayBuffer` so that `sign` and `verify` accept
	 * them without a further conversion.
	 */
	static signedMessageBytesFor(challengeHex: string): Uint8Array<ArrayBuffer> {
		const encoded = new TextEncoder().encode(`${AccountSignatureAlgorithm.signedMessagePrefix}${challengeHex}`);
		const bytes = new Uint8Array(encoded.length);
		bytes.set(encoded);
		return bytes;
	}

	/**
	 * Looks up one algorithm by name.
	 *
	 * @param name The algorithm name.
	 * @returns The algorithm, or `undefined` when this experiment does not know that name.
	 */
	static candidateByName(name: string): AccountSignatureAlgorithmCandidate | undefined {
		return AccountSignatureAlgorithm.candidates.find((candidate) => candidate.name === name);
	}

	/**
	 * Tests whether this browser can generate a key pair for one algorithm whose private key it
	 * refuses to hand back.
	 *
	 * A browser that generates the key pair but then exports the private key fails the probe:
	 * this experiment exists to establish that the private key stays inside the browser, so a
	 * generated key pair that can be read out is not the thing being looked for.
	 *
	 * @param candidate The algorithm to probe.
	 * @returns What the browser did.
	 */
	static async probe(candidate: AccountSignatureAlgorithmCandidate): Promise<AccountSignatureAlgorithmProbe> {
		let keyPair: CryptoKeyPair;
		try {
			keyPair = await crypto.subtle.generateKey(candidate.keyAlgorithm, false, ['sign', 'verify']) as CryptoKeyPair;
		} catch (error) {
			return {
				name: candidate.name,
				isSupported: false,
				detail: `generateKey was refused: ${AccountSignatureAlgorithm.messageOf(error)}`,
			};
		}
		if (keyPair.privateKey.extractable === true) {
			return {
				name: candidate.name,
				isSupported: false,
				detail: 'generateKey returned an extractable private key, which this experiment does not accept',
			};
		}
		try {
			await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
			return {
				name: candidate.name,
				isSupported: false,
				detail: 'exportKey returned the private key of a key pair generated as non-extractable',
			};
		} catch (error) {
			return {
				name: candidate.name,
				isSupported: true,
				detail: `key pair generated, private key export refused with: ${AccountSignatureAlgorithm.messageOf(error)}`,
			};
		}
	}

	/**
	 * Reads the message out of something a rejected promise carried.
	 *
	 * @param error Whatever the promise rejected with.
	 * @returns The message to write into the log.
	 */
	static messageOf(error: unknown): string {
		if (error instanceof Error) {
			return `${error.name}: ${error.message}`;
		}
		return String(error);
	}
}
