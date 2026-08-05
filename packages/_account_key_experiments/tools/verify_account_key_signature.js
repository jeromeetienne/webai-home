import Fs from 'node:fs';
import Crypto from 'node:crypto';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	VerifyAccountKeySignature — verifies, in Node.js, a signature a browser tab produced
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * @typedef {object} AccountKeySignatureDocument
 * @property {string} algorithmName Which signature algorithm produced the signature.
 * @property {string} userAgent The browser that produced it.
 * @property {string} keyPairCreatedAt When the key pair was generated.
 * @property {number} keyPairLoadCount How many page loads had found the key pair already stored.
 * @property {string} publicKeySpkiBase64 The public key in the `spki` encoding, as base64.
 * @property {string} publicKeyRawBase64 The public key in the `raw` encoding, as base64, or empty.
 * @property {string} challengeHex The challenge that was signed, as lower-case hexadecimal.
 * @property {string} signedMessage The exact text the challenge was signed inside.
 * @property {string} signatureBase64 The signature, as base64.
 * @property {string} signedAt When the signature was produced.
 */

/**
 * @typedef {object} SignatureAlgorithmDefinition
 * @property {Algorithm | EcKeyImportParams} keyAlgorithm The algorithm passed to `importKey`.
 * @property {Algorithm | EcdsaParams} signatureAlgorithm The algorithm passed to `verify`.
 */

/**
 * Verifies a signature a browser tab produced, using nothing the browser sent but the public key,
 * the challenge, and the signature.
 *
 * This script is the Node.js half of the de-risk gate of issue #122. It holds no browser code, and
 * it rebuilds the signed message from the challenge itself rather than trusting the text the
 * document carries, so a document whose `signedMessage` does not match its own `challengeHex` is
 * refused instead of being verified against whatever it happens to claim was signed.
 */
class VerifyAccountKeySignature {
	/** What is signed, before the challenge itself. Must match the browser page exactly. */
	static signedMessagePrefix = 'webai-at-home:account-authentication:v1:';

	/**
	 * The algorithms this script knows, by the name the browser page writes into the document.
	 *
	 * @type {Record<string, SignatureAlgorithmDefinition>}
	 */
	static algorithmDefinitions = {
		'Ed25519': {
			keyAlgorithm: {
				name: 'Ed25519',
			},
			signatureAlgorithm: {
				name: 'Ed25519',
			},
		},
		'ECDSA-P-256': {
			keyAlgorithm: {
				name: 'ECDSA',
				namedCurve: 'P-256',
			},
			signatureAlgorithm: {
				name: 'ECDSA',
				hash: 'SHA-256',
			},
		},
	};

	/**
	 * Runs the script.
	 *
	 * @param {string[]} args The command line arguments, without the program name.
	 * @returns {Promise<void>} Nothing. The process exit code says whether the gate passed.
	 */
	static async run(args) {
		const filePath = args[0];
		if (filePath === undefined || filePath === '') {
			console.error('Usage: node tools/verify_account_key_signature.js <verification_document.json>');
			console.error('       node tools/verify_account_key_signature.js -            reads the document from standard input');
			process.exitCode = 2;
			return;
		}
		const text = filePath === '-' ? Fs.readFileSync(0, 'utf8') : Fs.readFileSync(filePath, 'utf8');
		/** @type {AccountKeySignatureDocument} */
		const signatureDocument = JSON.parse(text);

		const definition = VerifyAccountKeySignature.algorithmDefinitions[signatureDocument.algorithmName];
		if (definition === undefined) {
			console.error(`FAIL  the document names an algorithm this script does not know: ${signatureDocument.algorithmName}`);
			process.exitCode = 1;
			return;
		}

		console.log(`document      algorithm ${signatureDocument.algorithmName}, signed at ${signatureDocument.signedAt}`);
		console.log(`browser       ${signatureDocument.userAgent}`);
		console.log(`key pair      generated at ${signatureDocument.keyPairCreatedAt}, found by ${signatureDocument.keyPairLoadCount} page load(s) since`);

		const expectedSignedMessage = `${VerifyAccountKeySignature.signedMessagePrefix}${signatureDocument.challengeHex}`;
		if (signatureDocument.signedMessage !== expectedSignedMessage) {
			console.error(`FAIL  signed message  the document says ${JSON.stringify(signatureDocument.signedMessage)}, but its own challenge gives ${JSON.stringify(expectedSignedMessage)}`);
			process.exitCode = 1;
			return;
		}
		console.log(`signed message ${expectedSignedMessage}`);

		const signedMessageBytes = new TextEncoder().encode(expectedSignedMessage);
		const signature = Buffer.from(signatureDocument.signatureBase64, 'base64');
		console.log(`signature     ${signature.length} bytes`);

		const spkiResult = await VerifyAccountKeySignature.verifyWith(definition, 'spki', signatureDocument.publicKeySpkiBase64, signature, signedMessageBytes);
		console.log(`spki key      ${spkiResult}`);

		const rawResult = signatureDocument.publicKeyRawBase64 === ''
			? 'not offered by this browser'
			: await VerifyAccountKeySignature.verifyWith(definition, 'raw', signatureDocument.publicKeyRawBase64, signature, signedMessageBytes);
		console.log(`raw key       ${rawResult}`);

		const isTamperedSignatureRefused = await VerifyAccountKeySignature.isTamperedChallengeRefused(definition, signatureDocument, signature);
		console.log(`tamper check  ${isTamperedSignatureRefused ? 'a changed challenge is refused, as it must be' : 'A CHANGED CHALLENGE WAS ACCEPTED'}`);

		const isPassed = spkiResult === 'verified' && isTamperedSignatureRefused;
		console.log(isPassed ? 'PASS  the signature this browser tab produced verifies in Node.js' : 'FAIL  the signature did not verify in Node.js');
		process.exitCode = isPassed ? 0 : 1;
	}

	/**
	 * Imports one encoding of the public key and verifies the signature with it.
	 *
	 * @param {SignatureAlgorithmDefinition} definition The algorithm the document names.
	 * @param {'spki' | 'raw'} format Which encoding of the public key to import.
	 * @param {string} publicKeyBase64 The public key in that encoding, as base64.
	 * @param {Buffer} signature The signature to verify.
	 * @param {Uint8Array} signedMessageBytes The bytes that were signed.
	 * @returns {Promise<string>} What happened, ready to print.
	 */
	static async verifyWith(definition, format, publicKeyBase64, signature, signedMessageBytes) {
		try {
			const publicKey = await Crypto.webcrypto.subtle.importKey(format, Buffer.from(publicKeyBase64, 'base64'), definition.keyAlgorithm, true, ['verify']);
			const isVerified = await Crypto.webcrypto.subtle.verify(definition.signatureAlgorithm, publicKey, signature, signedMessageBytes);
			return isVerified ? 'verified' : 'IMPORTED BUT DID NOT VERIFY';
		} catch (error) {
			const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			return `could not be used: ${message}`;
		}
	}

	/**
	 * Checks that the signature does not verify against a challenge it was not produced for.
	 *
	 * Without this check, a verification that always answered `true` would look like a pass.
	 *
	 * @param {SignatureAlgorithmDefinition} definition The algorithm the document names.
	 * @param {AccountKeySignatureDocument} signatureDocument The document being verified.
	 * @param {Buffer} signature The signature to verify.
	 * @returns {Promise<boolean>} Whether the changed challenge was refused.
	 */
	static async isTamperedChallengeRefused(definition, signatureDocument, signature) {
		const tamperedChallengeHex = `${signatureDocument.challengeHex.slice(0, -1)}${signatureDocument.challengeHex.endsWith('0') ? '1' : '0'}`;
		const tamperedBytes = new TextEncoder().encode(`${VerifyAccountKeySignature.signedMessagePrefix}${tamperedChallengeHex}`);
		const result = await VerifyAccountKeySignature.verifyWith(definition, 'spki', signatureDocument.publicKeySpkiBase64, signature, tamperedBytes);
		return result !== 'verified';
	}
}

await VerifyAccountKeySignature.run(process.argv.slice(2));
