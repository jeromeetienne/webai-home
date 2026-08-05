import type { AccountSignatureAlgorithmName } from './account_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountIdentity — what an account signs, how its key is written, and how its identifier is derived
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One key of an account key pair.
 *
 * The type is read off the environment's own Web Cryptography API rather than written as
 * `CryptoKey`, because that name is a global in a browser but not in Node.js, and this package is
 * used by both. Reading it from `crypto.subtle` itself means the type resolves wherever
 * `crypto.subtle` does, with no browser library added to a package the gateway also compiles.
 */
export type AccountCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** An account key pair: the private key that signs, and the public key that identifies it. */
export type AccountCryptoKeyPair = {
	/** The key that signs a challenge, which a browser page keeps non-exportable. */
	privateKey: AccountCryptoKey;
	/** The key the gateway holds, and the account identifier is derived from. */
	publicKey: AccountCryptoKey;
};

/**
 * A key written as a JSON Web Key, which is how a key pair is kept in a file.
 *
 * The type is read off the environment's own Web Cryptography API for the same reason
 * `AccountCryptoKey` is: `JsonWebKey` is a name a browser declares globally and Node.js does not.
 */
export type AccountKeyJsonWebKey = {
	/** The key type, `OKP` for an `Ed25519` key and `EC` for a `P-256` one. */
	kty?: string;
	/** The curve the key is on. */
	crv?: string;
	/** The public part, or its first coordinate. */
	x?: string;
	/** The second coordinate of a public point, on the curves that have one. */
	y?: string;
	/** The private part. It is only present in the copy a file keeps. */
	d?: string;
	/** The algorithm the key is for. */
	alg?: string;
	/** Whether the key may be exported again. */
	ext?: boolean;
	/** What the key may be used for. The field name is the one the standard gives it. */
	key_ops?: string[];
};

/** Everything needed to verify one signature over one gateway challenge. */
export type AccountSignatureCheck = {
	/** Which signature algorithm the account's key pair uses. */
	signatureAlgorithmName: AccountSignatureAlgorithmName;
	/** The account's public key, in the `spki` encoding, as base64. */
	publicKeySpkiBase64: string;
	/** The challenge the gateway handed out. */
	challenge: string;
	/** The signature the account produced over that challenge, as base64. */
	signatureBase64: string;
};

/**
 * The Web Cryptography API parameters one signature algorithm needs.
 *
 * The parameter types are spelled out here rather than written as `EcKeyGenParams` and
 * `EcdsaParams`, for the same reason `AccountCryptoKey` exists: those names are browser globals
 * that Node.js does not declare, and this package is compiled by both.
 */
type AlgorithmParameters = {
	/** The parameters passed to `generateKey` and to `importKey`. */
	keyAlgorithm: { name: string; namedCurve?: string };
	/** The parameters passed to `sign` and to `verify`. */
	signatureAlgorithm: { name: string; hash?: string };
};

/**
 * The one definition of what an account signs, how its public key is written down, and how its
 * identifier is derived from that key.
 *
 * The gateway in Node.js, the worker browser page, and `consumer_cli` all use this class, so none
 * of the three can disagree with the others about what a signature covers or about which account a
 * public key belongs to. It is written against the Web Cryptography API only, with no import from
 * `node:crypto` and none from the browser, because that API is present in both: Node.js has
 * offered `globalThis.crypto` since version 19.
 */
export class AccountIdentity {
	/**
	 * What is signed, before the challenge itself.
	 *
	 * The challenge is signed inside a message that names this project, this purpose, and this
	 * version, so that a signature produced to authenticate an account cannot be presented as a
	 * signature over something else the same key pair might one day be asked to sign.
	 */
	static readonly signedMessagePrefix = 'webai-at-home:account-authentication:v1:';

	/** How many hexadecimal characters of the public key digest an account identifier carries. */
	static readonly accountIdDigestLength = 32;

	/**
	 * Builds the bytes an account signs for one challenge.
	 *
	 * @param challenge The challenge the gateway handed out.
	 * @returns The bytes to sign, held in a plain `ArrayBuffer` so that `sign` and `verify` accept
	 * them without a further conversion.
	 */
	static signedMessageBytesFor(challenge: string): Uint8Array<ArrayBuffer> {
		const encoded = new TextEncoder().encode(`${AccountIdentity.signedMessagePrefix}${challenge}`);
		const bytes = new Uint8Array(encoded.length);
		bytes.set(encoded);
		return bytes;
	}

	/**
	 * Derives the account identifier of one public key.
	 *
	 * The identifier is a digest of the key rather than a value the gateway hands out, so the
	 * account a key belongs to is the same on every gateway, and an identifier cannot be claimed by
	 * anyone who does not hold the matching private key.
	 *
	 * @param publicKeySpkiBase64 The public key, in the `spki` encoding, as base64.
	 * @returns The account identifier.
	 */
	static async accountIdFor(publicKeySpkiBase64: string): Promise<string> {
		const digest = await crypto.subtle.digest('SHA-256', AccountIdentity.base64ToBytes(publicKeySpkiBase64));
		const hexadecimal = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
		return `account-${hexadecimal.slice(0, AccountIdentity.accountIdDigestLength)}`;
	}

	/**
	 * Generates a key pair for one account, with a private key the holder cannot export.
	 *
	 * @param signatureAlgorithmName Which algorithm the key pair is for.
	 * @param isPrivateKeyExtractable Whether the private key may be exported. A worker browser page
	 * leaves this `false`, so the key material never leaves the browser. A command line program
	 * that has to write its key pair to a file passes `true`, because a key it cannot export is a
	 * key it cannot keep past the end of the process.
	 * @returns The generated key pair.
	 */
	static async generateKeyPair(signatureAlgorithmName: AccountSignatureAlgorithmName, isPrivateKeyExtractable = false): Promise<AccountCryptoKeyPair> {
		const parameters = AccountIdentity.algorithmParametersFor(signatureAlgorithmName);
		return await crypto.subtle.generateKey(parameters.keyAlgorithm, isPrivateKeyExtractable, ['sign', 'verify']) as AccountCryptoKeyPair;
	}

	/**
	 * Writes a public key the way it travels in a message.
	 *
	 * @param publicKey The public key to write.
	 * @returns The key in the `spki` encoding, as base64.
	 */
	static async exportPublicKeySpkiBase64(publicKey: AccountCryptoKey): Promise<string> {
		return AccountIdentity.bytesToBase64(await crypto.subtle.exportKey('spki', publicKey));
	}

	/**
	 * Writes a private key the way a file keeps it.
	 *
	 * A command line program has to keep its key pair between runs, so unlike a browser page it
	 * generates an exportable private key and writes it out. That is the difference between the two:
	 * a browser holds a key it cannot export, and a file holds one it must be able to.
	 *
	 * @param privateKey The private key to write. It must have been generated as exportable.
	 * @returns The key as a JSON Web Key.
	 */
	static async exportPrivateKeyJsonWebKey(privateKey: AccountCryptoKey): Promise<AccountKeyJsonWebKey> {
		return await crypto.subtle.exportKey('jwk', privateKey);
	}

	/**
	 * Reads a private key back from the form a file keeps it in.
	 *
	 * The key comes back able to sign and nothing else, and not exportable again: what is on disk is
	 * already the copy that can be exported, and a second exportable copy in memory would serve no
	 * purpose.
	 *
	 * @param signatureAlgorithmName Which algorithm the key pair uses.
	 * @param privateKeyJsonWebKey The key as it was written to the file.
	 * @returns The private key, ready to sign a challenge.
	 */
	static async importPrivateKeyJsonWebKey(signatureAlgorithmName: AccountSignatureAlgorithmName, privateKeyJsonWebKey: AccountKeyJsonWebKey): Promise<AccountCryptoKey> {
		const parameters = AccountIdentity.algorithmParametersFor(signatureAlgorithmName);
		return await crypto.subtle.importKey('jwk', privateKeyJsonWebKey, parameters.keyAlgorithm, false, ['sign']);
	}

	/**
	 * Signs one gateway challenge.
	 *
	 * @param signatureAlgorithmName Which algorithm the key pair uses.
	 * @param privateKey The account's private key.
	 * @param challenge The challenge the gateway handed out.
	 * @returns The signature, as base64.
	 */
	static async signChallenge(signatureAlgorithmName: AccountSignatureAlgorithmName, privateKey: AccountCryptoKey, challenge: string): Promise<string> {
		const parameters = AccountIdentity.algorithmParametersFor(signatureAlgorithmName);
		const signature = await crypto.subtle.sign(parameters.signatureAlgorithm, privateKey, AccountIdentity.signedMessageBytesFor(challenge));
		return AccountIdentity.bytesToBase64(signature);
	}

	/**
	 * Checks one signature over one challenge against one public key.
	 *
	 * A key that cannot be imported, a signature that is not base64, and a signature that simply
	 * does not match all give the same answer: the signature is not accepted. The caller is told
	 * nothing about which of the three it was, because a client presenting a rejected signature has
	 * no use for that distinction.
	 *
	 * @param check The algorithm, the public key, the challenge, and the signature.
	 * @returns Whether the signature was produced over that challenge by the holder of the matching
	 * private key.
	 */
	static async verifyChallengeSignature(check: AccountSignatureCheck): Promise<boolean> {
		const parameters = AccountIdentity.algorithmParametersFor(check.signatureAlgorithmName);
		try {
			const publicKey = await crypto.subtle.importKey('spki', AccountIdentity.base64ToBytes(check.publicKeySpkiBase64), parameters.keyAlgorithm, true, ['verify']);
			return await crypto.subtle.verify(parameters.signatureAlgorithm, publicKey, AccountIdentity.base64ToBytes(check.signatureBase64), AccountIdentity.signedMessageBytesFor(check.challenge));
		} catch {
			return false;
		}
	}

	/**
	 * Writes bytes as base64.
	 *
	 * @param buffer The bytes to write.
	 * @returns The base64 text.
	 */
	static bytesToBase64(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		return btoa(binary);
	}

	/**
	 * Reads base64 back into bytes.
	 *
	 * @param base64 The base64 text.
	 * @returns The bytes it holds.
	 */
	static base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	}

	/**
	 * Reads the Web Cryptography API parameters one algorithm needs.
	 *
	 * @param signatureAlgorithmName The algorithm name as it appears in a message.
	 * @returns The parameters to pass to the Web Cryptography API.
	 */
	private static algorithmParametersFor(signatureAlgorithmName: AccountSignatureAlgorithmName): AlgorithmParameters {
		if (signatureAlgorithmName === 'Ed25519') {
			return {
				keyAlgorithm: {
					name: 'Ed25519',
				},
				signatureAlgorithm: {
					name: 'Ed25519',
				},
			};
		}
		return {
			keyAlgorithm: {
				name: 'ECDSA',
				namedCurve: 'P-256',
			},
			signatureAlgorithm: {
				name: 'ECDSA',
				hash: 'SHA-256',
			},
		};
	}
}
