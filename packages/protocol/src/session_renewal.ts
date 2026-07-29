///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SessionRenewal — decides when a client should authenticate again
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The shortest gap allowed between two renewals, in milliseconds.
 *
 * A very short session would otherwise make a client authenticate continuously.
 */
const minimumRenewalDelayMs = 1_000;

/**
 * Decides when a client should send `authenticate` again.
 *
 * The gateway enforces the expiry it advertises in `authenticated` (see
 * https://github.com/webai-at-home/webai-at-home/issues/54), so a client that holds a
 * connection open for longer than one session — a worker browser page, or a dashboard —
 * has to authenticate again before that moment or its next message is refused.
 *
 * Every such client uses this one rule, so that the moment a session is renewed is decided
 * in a single place rather than separately in each program.
 */
export class SessionRenewal {
	/**
	 * Returns how long to wait before authenticating again.
	 *
	 * The wait is half the remaining lifetime of the session, so a renewal that is lost or
	 * late still leaves as much time again for another attempt before the session actually
	 * runs out.
	 *
	 * @param expiresAt When the current session expires, as the ISO 8601 text the gateway sent.
	 * @param now The current time in milliseconds. Callers normally leave this unset.
	 * @returns How many milliseconds to wait before sending `authenticate` again.
	 */
	static renewAfterMs(expiresAt: string, now: number = Date.now()): number {
		const remainingMs = Date.parse(expiresAt) - now;
		if (Number.isFinite(remainingMs) === false) return minimumRenewalDelayMs;
		return Math.max(minimumRenewalDelayMs, Math.floor(remainingMs / 2));
	}
}
