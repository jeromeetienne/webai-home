import { AccountClient, type AccountClientOptions } from '../account/account_client.js';
import { AccountOutputFormatter, type AccountOutputFormat } from '../account/account_output_format.js';
import { CliError } from '../libs/cli_errors.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AccountBalanceCommand — prints what this account has earned, spent, and holds
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `consumer_cli account_balance` needs to connect and how to print. */
export type AccountBalanceCommandOptions = AccountClientOptions & {
	/** How to write the answer out. */
	format: AccountOutputFormat;
};

/**
 * Prints what this account holds: one credit for every stage it completed as a worker, less one for
 * every stage it had run as a consumer.
 *
 * A negative balance is a normal state in Version 1 and is not an error: a consumer that has run
 * more stages than it has completed simply owes that many, and nothing stops it running more.
 */
export class AccountBalanceCommand {
	/**
	 * Runs the command.
	 *
	 * @param options Where to connect and how to print.
	 * @returns Nothing.
	 * @throws {CliError} If the connection, the token, or the account is refused.
	 */
	static async run(options: AccountBalanceCommandOptions): Promise<void> {
		const client = new AccountClient(options);
		try {
			await client.connect();
			await client.authenticateAccount();
			const answer = await client.request({ type: 'account.balance.get' });
			if (answer.type !== 'account.balance') {
				throw new CliError(`The central gateway answered account.balance.get with ${answer.type}`, 4);
			}
			const summary = answer.summary;
			console.log(AccountOutputFormatter.format([
				['account identifier', summary.accountId],
				['balance', `${summary.balance > 0 ? '+' : ''}${String(summary.balance)} credit(s)`],
				['stages completed as a worker', String(summary.earnedStageCount)],
				['stages run as a consumer', String(summary.spentStageCount)],
			], summary, options.format));
		} finally {
			client.close();
		}
	}
}
