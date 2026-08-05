import Crypto from 'node:crypto';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChallengeRegistry — hands out one-time values for an account to sign
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One challenge handed to one connection. */
export type AccountChallenge = {
	/** The value to sign, as lower-case hexadecimal. */
	challenge: string;
	/** When it stops being usable, in milliseconds since the epoch. */
	expiresAt: number;
};

/** Why a challenge was not accepted, or that it was. */
export type ChallengeVerdict = 'accepted' | 'unknown' | 'expired';

/**
 * Hands out the values an account signs to prove it holds its private key.
 *
 * Two rules make the signature worth asking for. The value is random, so a signature captured from
 * one connection says nothing about what the next connection will be asked to sign. And the value is
 * usable once: it is forgotten the moment it is presented, whether the signature over it was
 * accepted or refused, so a captured signature cannot be replayed even within the challenge's own
 * lifetime.
 *
 * A challenge belongs to the connection it was handed to, so a value handed to one connection cannot
 * be signed by another.
 */
export class ChallengeRegistry {
	/** The outstanding challenge of each connection, by device identifier. */
	private readonly challengesByDeviceId = new Map<string, AccountChallenge>();

	/**
	 * @param challengeDurationMs How long a challenge stays usable after it is handed out.
	 * @param now Where the current time in milliseconds is read from. Tests pass their own.
	 */
	constructor(private readonly challengeDurationMs = 60_000, private readonly now: () => number = () => Date.now()) {}

	/**
	 * Hands a fresh challenge to one connection, replacing any it already had.
	 *
	 * Challenges that have expired on other connections are dropped here, so a gateway running for a
	 * long time does not keep a record for every connection that ever asked for one and then went
	 * away.
	 *
	 * @param deviceId The connection asking for a challenge.
	 * @returns The challenge and when it expires.
	 */
	issue(deviceId: string): AccountChallenge {
		const now = this.now();
		for (const [otherDeviceId, outstanding] of this.challengesByDeviceId) {
			if (outstanding.expiresAt <= now) {
				this.challengesByDeviceId.delete(otherDeviceId);
			}
		}
		const challenge: AccountChallenge = {
			challenge: Crypto.randomBytes(32).toString('hex'),
			expiresAt: now + this.challengeDurationMs,
		};
		this.challengesByDeviceId.set(deviceId, challenge);
		return challenge;
	}

	/**
	 * Takes one connection's outstanding challenge, so it can never be used a second time.
	 *
	 * @param deviceId The connection presenting a signature.
	 * @returns `accepted` with the value that was signed, or why there is nothing to check against.
	 */
	consume(deviceId: string): { verdict: ChallengeVerdict; challenge?: string } {
		const outstanding = this.challengesByDeviceId.get(deviceId);
		if (outstanding === undefined) {
			return {
				verdict: 'unknown',
			};
		}
		this.challengesByDeviceId.delete(deviceId);
		if (outstanding.expiresAt <= this.now()) {
			return {
				verdict: 'expired',
			};
		}
		return {
			verdict: 'accepted',
			challenge: outstanding.challenge,
		};
	}

	/**
	 * Forgets a connection's outstanding challenge, when that connection closes.
	 *
	 * @param deviceId The connection that closed.
	 */
	close(deviceId: string): void {
		this.challengesByDeviceId.delete(deviceId);
	}
}
