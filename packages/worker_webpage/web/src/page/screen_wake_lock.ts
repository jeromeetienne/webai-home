///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ScreenWakeLock — asks the system to keep the screen on while the worker page is visible
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Whether the screen wake lock is off, held, or not available in this browser.
 *
 * `'unsupported'` covers both an insecure origin and a browser that never implemented the
 * Screen Wake Lock interface, since `navigator.wakeLock` is undefined in both cases (see
 * [issue #145](https://github.com/webai-at-home/webai-at-home/issues/145)).
 */
export type ScreenWakeLockState = 'stopped' | 'held' | 'unsupported';

/**
 * Holds a screen wake lock for as long as the worker page is visible and the lock is enabled.
 *
 * The system releases the lock on its own whenever the document becomes hidden — switching
 * tabs, locking the phone, backgrounding the browser — so this listens for the document
 * becoming visible again and asks for the lock back then. The request can be refused for
 * reasons outside this page's control, such as Battery Saver being on, so a refusal is logged
 * and otherwise left silent: keeping the screen on is an enhancement, not something the page
 * needs in order to work.
 */
export class ScreenWakeLock {
	private static sentinel: WakeLockSentinel | undefined;
	/**
	 * Whether the reader has asked for the lock to be held, independent of whether it currently
	 * is. A document that stays hidden holds no sentinel for as long as it stays hidden, so
	 * `state()` alone cannot tell a caller whether the lock is off or merely waiting for the
	 * document to become visible; `isEnabled()` is the one to check for that.
	 */
	private static enabled = false;
	private static onVisibilityChange: (() => void) | undefined;

	/**
	 * Enables the lock and acquires it immediately, if the document is visible.
	 *
	 * Safe to call from a click handler even before the request settles: `enabled` is set
	 * synchronously, so a document that turns visible again while the first request is still
	 * pending is still picked up by the visibility listener registered here.
	 */
	static start(): void {
		if (ScreenWakeLock.enabled) {
			return;
		}
		ScreenWakeLock.enabled = true;
		const onVisibilityChange = (): void => {
			void ScreenWakeLock.acquire();
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		ScreenWakeLock.onVisibilityChange = onVisibilityChange;
		void ScreenWakeLock.acquire();
	}

	/** Disables the lock and releases it, if it is currently held. */
	static stop(): void {
		if (ScreenWakeLock.enabled === false) {
			return;
		}
		ScreenWakeLock.enabled = false;
		if (ScreenWakeLock.onVisibilityChange !== undefined) {
			document.removeEventListener('visibilitychange', ScreenWakeLock.onVisibilityChange);
			ScreenWakeLock.onVisibilityChange = undefined;
		}
		void ScreenWakeLock.sentinel?.release();
		ScreenWakeLock.sentinel = undefined;
	}

	/** Reports whether the reader has asked for the lock to be held, whether or not it currently is. */
	static isEnabled(): boolean {
		return ScreenWakeLock.enabled;
	}

	/** Reports the screen wake lock's current state. */
	static state(): ScreenWakeLockState {
		if (('wakeLock' in navigator) === false) {
			return 'unsupported';
		}
		return ScreenWakeLock.sentinel === undefined ? 'stopped' : 'held';
	}

	/**
	 * Requests the lock, unless it is disabled, already held, or the document is hidden.
	 *
	 * Requesting while the document is hidden throws `NotAllowedError`, so this checks
	 * `document.visibilityState` first rather than relying on the browser to refuse it.
	 */
	private static async acquire(): Promise<void> {
		if (ScreenWakeLock.enabled === false || ScreenWakeLock.sentinel !== undefined) {
			return;
		}
		if (document.visibilityState !== 'visible' || ('wakeLock' in navigator) === false) {
			return;
		}
		try {
			const sentinel = await navigator.wakeLock.request('screen');
			sentinel.addEventListener('release', (): void => {
				if (ScreenWakeLock.sentinel === sentinel) {
					ScreenWakeLock.sentinel = undefined;
				}
			});
			ScreenWakeLock.sentinel = sentinel;
		} catch (error) {
			console.warn('screen wake lock refused', error);
		}
	}
}
