import Fs from 'node:fs';
import Path from 'node:path';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountIdentityFile — keeps this participant's account profile in one file
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The file's contents, exactly as they are written. */
export type StoredAccountIdentity = {
	/** The display name for the account profile. May be empty. */
	displayName: string;
	/** The email address for the account profile. May be empty. */
	emailAddress: string;
};

/** The fixed name of the identity file inside a configuration directory. */
const accountIdentityFileName = 'default.identity.json';

/**
 * Keeps this participant's account profile — a display name and an email address — in one file
 * inside the configuration directory, next to the account key pair that `AccountKeyFile` keeps.
 *
 * The key pair is the account and this file is only what the participant chooses to be called, so
 * the two are kept apart: this file holds no secret, is edited by hand, and may be absent. An absent
 * file, or a file missing either field, reads as the empty string for that field, which is the same
 * anonymous profile a worker browser tab registers with. That is deliberate — a volunteer has agreed
 * to donate computing time, not to give an email address.
 *
 * Nothing in this project writes this file. Registering a public key the central gateway already
 * knows changes nothing, because registration does not prove that the sender holds the private key,
 * so a display name and an email address are stated once when the account is first registered and
 * cannot be edited afterwards in Version 1 of the accounting system.
 *
 * It reads files, so unlike everything else in this package it cannot run in a browser, which is why
 * it is reached through the `@webai/protocol/account_identity_file` subpath and is not exported from
 * this package's main entry point.
 */
export class AccountIdentityFile {
	/**
	 * Gives the path of the identity file inside a configuration directory.
	 *
	 * The name inside the directory is fixed, so `consumer_cli`, `consumer_openai`, and
	 * `worker_openai` each name only the directory and land on the same file name.
	 *
	 * @param configDir The configuration directory the identity file sits in.
	 * @returns The path of the identity file.
	 */
	static pathInConfigDir(configDir: string): string {
		return Path.join(configDir, accountIdentityFileName);
	}

	/**
	 * Reads the profile back, treating an absent file and a missing field alike as empty.
	 *
	 * @param filePath Where the profile would be kept.
	 * @returns The display name and the email address, each the empty string when it was not stated.
	 * @throws {Error} If the file is there but is not JSON.
	 */
	static read(filePath: string): StoredAccountIdentity {
		if (Fs.existsSync(filePath) === false) {
			return {
				displayName: '',
				emailAddress: '',
			};
		}
		let stored: Partial<StoredAccountIdentity>;
		try {
			stored = JSON.parse(Fs.readFileSync(filePath, 'utf8')) as Partial<StoredAccountIdentity>;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`The account identity at ${filePath} is not readable as JSON: ${message}`);
		}
		return {
			displayName: typeof stored.displayName === 'string' ? stored.displayName : '',
			emailAddress: typeof stored.emailAddress === 'string' ? stored.emailAddress : '',
		};
	}
}
