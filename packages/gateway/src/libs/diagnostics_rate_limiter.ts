///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DiagnosticsRateLimiter — caps how many diagnostic entries one device may report
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Limits how many diagnostic entries each device may report over a rolling window.
 *
 * Diagnostic reporting used to travel on the same connection as scheduling, with no limit
 * at all, so a worker could push arbitrary volume down the connection the gateway needs for
 * assigning stages and collecting results (see
 * https://github.com/webai-at-home/webai-at-home/issues/50). Reporting now has its own
 * transport, and this class is what keeps it from becoming unbounded there instead.
 *
 * The window is a rolling one rather than a fixed calendar window, so a device cannot send
 * its whole allowance at the end of one window and its whole allowance again immediately
 * afterwards.
 */
export class DiagnosticsRateLimiter {
	/** When each device's recorded entries were accepted, by device identifier. */
	private readonly acceptedTimestamps = new Map<string, number[]>();

	/**
	 * @param maximumEntriesPerWindow How many entries one device may report per window.
	 * @param windowMs How long the rolling window is, in milliseconds.
	 */
	constructor(
		private readonly maximumEntriesPerWindow = 600,
		private readonly windowMs = 10_000,
	) {}

	/**
	 * Records a report of `entryCount` entries from one device, if its allowance covers them.
	 *
	 * The whole report is accepted or refused together rather than partly recorded, so a
	 * worker is never left guessing which of the entries it sent were kept.
	 *
	 * @param deviceId The device reporting the entries.
	 * @param entryCount How many entries the report carries.
	 * @param now The current time in milliseconds. Callers normally leave this unset.
	 * @returns Whether the report was accepted, and how much of the allowance is left.
	 */
	accept(deviceId: string, entryCount: number, now: number = Date.now()): { isAccepted: boolean; remaining: number; retryAfterMs: number } {
		const recent = this._recentTimestamps(deviceId, now);

		if (recent.length + entryCount > this.maximumEntriesPerWindow) {
			// The allowance frees up as the oldest recorded entry leaves the window.
			const oldest = recent[0];
			const retryAfterMs = oldest === undefined ? this.windowMs : Math.max(1, oldest + this.windowMs - now);
			return { isAccepted: false, remaining: Math.max(0, this.maximumEntriesPerWindow - recent.length), retryAfterMs };
		}

		for (let index = 0; index < entryCount; index += 1) recent.push(now);
		this.acceptedTimestamps.set(deviceId, recent);
		return { isAccepted: true, remaining: this.maximumEntriesPerWindow - recent.length, retryAfterMs: 0 };
	}

	/**
	 * Forgets a device's recorded entries, freeing its whole allowance.
	 *
	 * Called when a device disconnects, so its identifier does not accumulate here for as
	 * long as the gateway runs.
	 *
	 * @param deviceId The device to forget.
	 */
	forget(deviceId: string): void {
		this.acceptedTimestamps.delete(deviceId);
	}

	/**
	 * Returns a device's recorded entry times, with everything older than the window dropped.
	 *
	 * @param deviceId The device whose entries to read.
	 * @param now The current time in milliseconds.
	 * @returns The times still inside the window, oldest first.
	 */
	private _recentTimestamps(deviceId: string, now: number): number[] {
		const recorded = this.acceptedTimestamps.get(deviceId) ?? [];
		const windowStart = now - this.windowMs;
		// The array is always in ascending order, so dropping the expired prefix is enough.
		let firstInsideWindow = 0;
		while (firstInsideWindow < recorded.length && (recorded[firstInsideWindow] ?? 0) <= windowStart) firstInsideWindow += 1;
		return firstInsideWindow === 0 ? recorded : recorded.slice(firstInsideWindow);
	}
}
