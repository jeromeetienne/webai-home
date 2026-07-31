///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	IdleProbe — measures what this tab's timers, animation frames, and raw
//	compute speed actually do as the tab moves between focused, visible but
//	unfocused, and backgrounded
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What kind of measurement one log row reports. */
export type LogRowKind = 'visibility' | 'focus' | 'timer' | 'raf' | 'cpu';

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

/**
 * The nominal delay, in milliseconds, of the recurring timer used to measure timer drift and to
 * pace the animation-frame count and the periodic CPU benchmark.
 *
 * A backgrounded tab is exactly where this delay is least trustworthy, which is the point:
 * comparing what was asked for against what actually happened is the measurement.
 */
const TIMER_NOMINAL_INTERVAL_MS = 1000;

/** How many timer ticks pass between two runs of the CPU throughput benchmark. */
const CPU_BENCHMARK_EVERY_N_TICKS = 5;

/**
 * How many loop iterations the CPU throughput benchmark runs.
 *
 * Chosen to take roughly 50-150 ms on a modern desktop CPU when the tab is not throttled, so a
 * slowdown is visible against that baseline without the benchmark itself dominating the log.
 * There is nothing exact about this number; it may need to be raised or lowered for a
 * particular machine.
 */
const CPU_BENCHMARK_ITERATIONS = 15_000_000;

/**
 * Runs every measurement this experiment takes, and reports each one as it happens.
 *
 * Nothing here needs the reader to interact with the page after it starts: the point is to
 * start it, move the tab between focused, visible-but-unfocused, and backgrounded, and read the
 * log afterwards.
 */
export class IdleProbe {
	/** Animation-frame ticks counted since the last time a timer tick reported and reset it. */
	private static rafTickCount = 0;

	/**
	 * Starts every measurement.
	 *
	 * @param onLogRow Called with each measurement, in the order it was taken.
	 * @param onStateChange Called with the tab's current visibility and focus, once immediately
	 * and again on every change.
	 */
	static start(onLogRow: (row: LogRow) => void, onStateChange: (state: IdlePageState) => void): void {
		IdleProbe.watchVisibilityAndFocus(onLogRow, onStateChange);
		IdleProbe.watchAnimationFrames();
		IdleProbe.scheduleTick(onLogRow, 0);
	}

	/** Reports the current visibility and focus, and logs every change to either. */
	private static watchVisibilityAndFocus(onLogRow: (row: LogRow) => void, onStateChange: (state: IdlePageState) => void): void {
		document.addEventListener('visibilitychange', () => {
			onLogRow({ timestamp: IdleProbe.now(), kind: 'visibility', message: `document.visibilityState is now "${document.visibilityState}"` });
			onStateChange({ visibility: document.visibilityState, isFocused: document.hasFocus() });
		});
		window.addEventListener('focus', () => {
			onLogRow({ timestamp: IdleProbe.now(), kind: 'focus', message: 'window gained focus' });
			onStateChange({ visibility: document.visibilityState, isFocused: true });
		});
		window.addEventListener('blur', () => {
			onLogRow({ timestamp: IdleProbe.now(), kind: 'focus', message: 'window lost focus' });
			onStateChange({ visibility: document.visibilityState, isFocused: false });
		});
		onStateChange({ visibility: document.visibilityState, isFocused: document.hasFocus() });
	}

	/**
	 * Counts animation frames as they are delivered.
	 *
	 * A hidden tab receives none at all, so the count itself — read and reset by the timer tick
	 * below — is the measurement; nothing here reports on its own.
	 */
	private static watchAnimationFrames(): void {
		const tick = (): void => {
			IdleProbe.rafTickCount += 1;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}

	/**
	 * Fires roughly once a second, reports the timer's own drift and the animation-frame count
	 * since the previous tick, and — every {@link CPU_BENCHMARK_EVERY_N_TICKS} ticks — runs the
	 * CPU throughput benchmark and reports that too.
	 *
	 * @param onLogRow Called with each measurement this tick produces.
	 * @param tickIndex How many ticks have fired before this one, which paces the CPU benchmark.
	 */
	private static scheduleTick(onLogRow: (row: LogRow) => void, tickIndex: number): void {
		const scheduledAt = performance.now();
		setTimeout(() => {
			const actualDelayMs = performance.now() - scheduledAt;
			const driftMs = actualDelayMs - TIMER_NOMINAL_INTERVAL_MS;
			const driftText = `${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(0)} ms`;
			onLogRow({ timestamp: IdleProbe.now(), kind: 'timer', message: `${TIMER_NOMINAL_INTERVAL_MS} ms timer fired after ${actualDelayMs.toFixed(0)} ms (drift ${driftText})` });

			const rafTicksInWindow = IdleProbe.rafTickCount;
			IdleProbe.rafTickCount = 0;
			onLogRow({ timestamp: IdleProbe.now(), kind: 'raf', message: `${rafTicksInWindow} animation frame${rafTicksInWindow === 1 ? '' : 's'} since the last tick` });

			if (tickIndex % CPU_BENCHMARK_EVERY_N_TICKS === 0) {
				const cpuMs = IdleProbe.runCpuBenchmark();
				onLogRow({ timestamp: IdleProbe.now(), kind: 'cpu', message: `fixed ${CPU_BENCHMARK_ITERATIONS.toLocaleString()}-iteration loop took ${cpuMs.toFixed(1)} ms` });
			}

			IdleProbe.scheduleTick(onLogRow, tickIndex + 1);
		}, TIMER_NOMINAL_INTERVAL_MS);
	}

	/**
	 * Runs a fixed amount of synchronous main-thread work and times it.
	 *
	 * This is deliberately unrelated to timers or animation frames: it measures whether the
	 * browser also slows down computation that is already running on the main thread, which is
	 * a different question from whether it delays scheduling that computation in the first
	 * place.
	 *
	 * @returns How many milliseconds the fixed workload took.
	 */
	private static runCpuBenchmark(): number {
		const startedAt = performance.now();
		let accumulator = 0;
		for (let index = 0; index < CPU_BENCHMARK_ITERATIONS; index += 1) {
			accumulator += Math.sqrt(index) % 7;
		}
		// Reading `accumulator` through a condition that never holds is what stops the loop above
		// from being optimized away as dead code, since nothing else uses its result.
		if (accumulator === Number.NEGATIVE_INFINITY) console.log(accumulator);
		return performance.now() - startedAt;
	}

	/** The current time as an ISO timestamp. */
	private static now(): string {
		return new Date().toISOString();
	}
}
