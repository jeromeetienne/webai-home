import type { AccountProfile } from '@webai/protocol';
import { AccountClient, type AccountClientOptions } from '../account/account_client.js';
import { AccountOutputFormatter, type AccountOutputFormat } from '../account/account_output_format.js';
import { CliError } from '../libs/cli_errors.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountInformationCommand — prints the profile the central gateway holds for this account
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `consumer_cli account_information` needs to connect and how to print. */
export type AccountInformationCommandOptions = AccountClientOptions & {
	/** How to write the answer out. */
	format: AccountOutputFormat;
};

/** Prints the profile the central gateway holds for the account this machine's key pair is. */
export class AccountInformationCommand {
	/**
	 * Runs the command.
	 *
	 * @param options Where to connect and how to print.
	 * @returns Nothing.
	 * @throws {CliError} If the connection, the token, or the account is refused.
	 */
	static async run(options: AccountInformationCommandOptions): Promise<void> {
		const client = new AccountClient(options);
		try {
			await client.connect();
			await client.authenticateAccount();
			const answer = await client.request({ type: 'account.get' });
			if (answer.type !== 'account.profile') {
				throw new CliError(`The central gateway answered account.get with ${answer.type}`, 4);
			}
			const account: AccountProfile = answer.account;
			console.log(AccountOutputFormatter.format([
				['account identifier', account.accountId],
				['signature algorithm', account.signatureAlgorithmName],
				['public key', account.publicKeySpkiBase64],
				['display name', account.displayName === '' ? '(none)' : account.displayName],
				['email address', account.emailAddress === '' ? '(none)' : account.emailAddress],
				['registered at', account.createdAt],
			], account, options.format));
		} finally {
			client.close();
		}
	}
}
