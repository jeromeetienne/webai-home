///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	IdleProbe — watches this tab's visibility and focus while generation runs
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * A smaller sibling of `visibility_timer_log/src/idle_probe.ts`: this experiment's workload is
 * the model's own generation cycle rather than a synthetic timer, so only visibility and focus
 * watching are needed here — the generation loop in `main.ts` is what times the work.
 */

/** What kind of measurement one log row reports. */
export type LogRowKind = 'visibility' | 'focus' | 'generation' | 'status';

/** One measurement, ready to display. */
export type LogRow = {
	/** When the measurement was taken, as an ISO timestamp. */
	timestamp: string;
	/** What kind of measurement this is. */
	kind: LogRowKind;
	/** The measurement itself, already formatted for display. */
	message: string;
};

/** The tab's visibility and focus, as read from the two browser APIs that report it. */
export type IdlePageState = {
	visibility: DocumentVisibilityState;
	isFocused: boolean;
};

/** Watches this tab's visibility and focus, reporting the current state and every change to it. */
export class IdleProbe {
	/**
	 * Starts watching visibility and focus.
	 *
	 * @param onLogRow Called once for every visibility or focus change.
	 * @param onStateChange Called with the tab's current visibility and focus, once immediately
	 * and again on every change.
	 */
	static start(onLogRow: (row: LogRow) => void, onStateChange: (state: IdlePageState) => void): void {
		document.addEventListener('visibilitychange', () => {
			onLogRow({ timestamp: IdleProbe.now(), kind: 'visibility', message: `document.visibilityState is now "${document.visibilityState}"` });
			onStateChange(IdleProbe.currentState());
		});
		window.addEventListener('focus', () => {
			onLogRow({ timestamp: IdleProbe.now(), kind: 'focus', message: 'window gained focus' });
			onStateChange(IdleProbe.currentState());
		});
		window.addEventListener('blur', () => {
			onLogRow({ timestamp: IdleProbe.now(), kind: 'focus', message: 'window lost focus' });
			onStateChange(IdleProbe.currentState());
		});
		onStateChange(IdleProbe.currentState());
	}

	/** Reads the tab's current visibility and focus. */
	static currentState(): IdlePageState {
		return { visibility: document.visibilityState, isFocused: document.hasFocus() };
	}

	/** The current time as an ISO timestamp. */
	static now(): string {
		return new Date().toISOString();
	}
}
