import Crypto from 'node:crypto';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** An authenticated session held by one connection. */
export type Session = {
	/** Who authenticated, used as the key for the per-principal active-task limit. */
	principal: string;
	/** When this session stops being valid, in milliseconds since the epoch. */
	expiresAt: number;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SessionRegistry — holds who is authenticated on each connection, and until when
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Records which connections have authenticated, as whom, and until when.
 *
 * The gateway used to tell a client its session expired one hour later and then never look
 * at that time again, so a connection stayed authenticated for as long as it stayed open
 * (see https://github.com/webai-at-home/webai-at-home/issues/54). This class is what makes
 * the advertised expiry real: every message is checked against it, and an expired session is
 * refused until the connection authenticates again.
 *
 * The single shared token this gateway accepts is a development placeholder, not real
 * authentication. What this class provides is that the gateway honours the session rules it
 * states, and that a principal is derived from a whole credential rather than from a prefix
 * of one.
 */
export class SessionRegistry {
	/** The open sessions, by device identifier. */
	private readonly sessionsByDeviceId = new Map<string, Session>();

	/**
	 * @param sessionDurationMs How long a session lasts from the moment it is opened.
	 */
	constructor(private readonly sessionDurationMs = 3_600_000) {}

	/**
	 * Derives the principal for a credential.
	 *
	 * The principal used to be the first twelve characters of the token, which meant two
	 * different tokens sharing a prefix became the same principal, and it also copied most of
	 * the credential itself into every task record and log file. It is now a digest of the
	 * whole credential, so two different tokens cannot collide and no part of the credential
	 * is readable in what the digest produces.
	 *
	 * This derives an identity from the credential the gateway was given. It is not a claim
	 * that the credential itself is trustworthy: a single shared token still identifies
	 * everyone who holds it as the same principal, which is exactly what a shared token means.
	 *
	 * @param token The credential presented by the client.
	 * @returns The principal for that credential.
	 */
	static principalFor(token: string): string {
		const digest = Crypto.createHash('sha256').update(token, 'utf8').digest('hex');
		return `principal-${digest.slice(0, 16)}`;
	}

	/**
	 * Opens a session for a connection that has just presented a valid credential.
	 *
	 * @param deviceId The connection's device identifier.
	 * @param token The credential the client presented.
	 * @param now The current time in milliseconds. Callers normally leave this unset.
	 * @returns The session that was opened.
	 */
	open(deviceId: string, token: string, now: number = Date.now()): Session {
		const session: Session = { principal: SessionRegistry.principalFor(token), expiresAt: now + this.sessionDurationMs };
		this.sessionsByDeviceId.set(deviceId, session);
		return session;
	}

	/**
	 * Returns the connection's session, if it has one that has not expired.
	 *
	 * An expired session is forgotten as it is found, so the connection is treated as
	 * unauthenticated from then on and its next `authenticate` opens a fresh session on the
	 * same connection. The connection itself is never closed: expiry means the client must
	 * authenticate again, not that it must reconnect.
	 *
	 * @param deviceId The connection's device identifier.
	 * @param now The current time in milliseconds. Callers normally leave this unset.
	 * @returns The live session, or undefined when there is none or it has expired.
	 */
	active(deviceId: string, now: number = Date.now()): Session | undefined {
		const session = this.sessionsByDeviceId.get(deviceId);
		if (session === undefined) return undefined;
		if (session.expiresAt > now) return session;
		this.sessionsByDeviceId.delete(deviceId);
		return undefined;
	}

	/**
	 * Ends a connection's session, whether or not it had expired.
	 *
	 * @param deviceId The connection's device identifier.
	 */
	close(deviceId: string): void {
		this.sessionsByDeviceId.delete(deviceId);
	}
}
