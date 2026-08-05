import { AccountClient, type AccountClientOptions } from '../account/account_client.js';
import { AccountOutputFormatter, type AccountOutputFormat } from '../account/account_output_format.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountRegisterCommand — tells the central gateway about this machine's public key
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `consumer_cli account_register` needs to connect and what profile to state. */
export type AccountRegisterCommandOptions = AccountClientOptions & {
	/** The email address for the profile. May be empty. */
	emailAddress: string;
	/** The display name for the profile. May be empty. */
	displayName: string;
	/** How to write the answer out. */
	format: AccountOutputFormat;
};

/**
 * Registers this machine's public key with the central gateway.
 *
 * Registering a public key the gateway already knows changes nothing and reports the profile it
 * already holds, so running this twice is harmless. Editing a profile after the fact is not part of
 * Version 1: registration does not prove that the sender holds the private key, so it must not be
 * able to rewrite the email address or display name of an account somebody else owns.
 */
export class AccountRegisterCommand {
	/**
	 * Runs the command.
	 *
	 * @param options Where to connect, what profile to state, and how to print.
	 * @returns Nothing.
	 * @throws {CliError} If the connection, the token, or the registration is refused.
	 */
	static async run(options: AccountRegisterCommandOptions): Promise<void> {
		const client = new AccountClient(options);
		try {
			await client.connect();
			const registered = await client.registerAccount(options.emailAddress, options.displayName);
			console.log(AccountOutputFormatter.format([
				['account identifier', registered.account.accountId],
				['was created now', registered.isNewAccount ? 'yes' : 'no, this gateway already held it'],
				['display name', registered.account.displayName === '' ? '(none)' : registered.account.displayName],
				['email address', registered.account.emailAddress === '' ? '(none)' : registered.account.emailAddress],
				['registered at', registered.account.createdAt],
			], {
				account: registered.account,
				isNewAccount: registered.isNewAccount,
			}, options.format));
		} finally {
			client.close();
		}
	}
}
