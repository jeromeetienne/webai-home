import { z } from 'zod';
import { Identifier } from '../identifier.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountTypes — the permanent account a participant owns
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The signature algorithms an account key pair may use.
 *
 * `Ed25519` is what every browser tested in the de-risk gate of
 * https://github.com/webai-at-home/webai-at-home/issues/124 chose, and it is what a participant
 * should use. `ECDSA-P-256` is kept for a browser that offers no `Ed25519`, because the Web
 * Cryptography API has supported that curve for far longer.
 */
export const AccountSignatureAlgorithmName = z.enum(['Ed25519', 'ECDSA-P-256']);
/** The signature algorithms an account key pair may use. */
export type AccountSignatureAlgorithmName = z.infer<typeof AccountSignatureAlgorithmName>;

/**
 * An account identifier.
 *
 * It is derived from the account's own public key rather than handed out by the gateway, so an
 * identifier cannot be claimed by anyone who does not hold the matching private key.
 */
export const AccountId = Identifier;

/**
 * A public key as it travels in a message: the `spki` encoding of the key, written as base64.
 *
 * The `spki` encoding is used rather than the `raw` one because every browser and Node.js accept
 * it for both algorithms, which the de-risk gate confirmed on Google Chrome, Safari, and the
 * in-app Chromium of Claude Code.
 */
export const AccountPublicKeySpkiBase64 = z.string().min(1).max(2_000);

/** A signature over a gateway challenge, written as base64. */
export const AccountSignatureBase64 = z.string().min(1).max(2_000);

/**
 * The email address on an account profile.
 *
 * Version 1 does not check that the text is a deliverable address, and accepts an empty one,
 * because a volunteer opening a worker browser page has not agreed to give an email address and
 * the page registers an account for that volunteer either way.
 */
export const AccountEmailAddress = z.string().max(320);

/** The display name on an account profile. */
export const AccountDisplayName = z.string().max(200);

/** One participant's permanent account, as the gateway holds it. */
export const AccountProfileSchema = z.object({
	/** The account identifier, derived from `publicKeySpkiBase64`. */
	accountId: AccountId,
	/** Which signature algorithm this account's key pair uses. */
	signatureAlgorithmName: AccountSignatureAlgorithmName,
	/** The account's public key, in the `spki` encoding, as base64. */
	publicKeySpkiBase64: AccountPublicKeySpkiBase64,
	/** The email address the account was registered with, which may be empty. */
	emailAddress: AccountEmailAddress,
	/** The display name the account was registered with, which may be empty. */
	displayName: AccountDisplayName,
	/** When the account was registered, as an ISO 8601 timestamp. */
	createdAt: z.string().min(1).max(40),
}).strict();
/** One participant's permanent account, as the gateway holds it. */
export type AccountProfile = z.infer<typeof AccountProfileSchema>;
