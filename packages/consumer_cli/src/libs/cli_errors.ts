///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CliError — a command failure carrying the process exit code it must end with
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The process exit code one of this package's commands ends with.
 *
 * `0` is success. `1`, `2`, `3`, and `4` are reserved for `status` and `capacity`, whose
 * commands talk to the central gateway before they have anything to show and therefore need
 * to tell apart why that conversation did not finish: the gateway was unreachable (`1`), the
 * bearer token it was given was refused (`2`), it took longer than the allowed time to answer
 * (`3`), or it answered with something this client could not make sense of (`4`).
 */
export type CliExitCode = 0 | 1 | 2 | 3 | 4;

/**
 * A command failure that already knows which exit code the process must end with.
 *
 * Thrown by the libraries `status` and `capacity` share, and caught once at the top of the
 * command line program, so that every command reports its own failure the same way rather
 * than each command deciding its own exit code inline.
 */
export class CliError extends Error {
	/**
	 * @param message What went wrong, in words, printed to `stderr` as-is.
	 * @param exitCode The process exit code this failure ends the command with.
	 */
	constructor(message: string, readonly exitCode: CliExitCode) {
		super(message);
	}
}
