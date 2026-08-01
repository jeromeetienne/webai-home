///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Offscreen — plays a quiet tone and measures this document's own timer
//	drift and CPU throughput, entirely outside of any browser tab
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * This document is never a tab: it has no visibility state a person could see, cover, minimize,
 * or focus, and chrome.offscreen guarantees at most one of these exists per extension. What this
 * file measures is whether that matters — whether this document's timers and raw computation
 * stay steady while the Chrome application itself is backgrounded, the way the sibling
 * `public/visibility_timer_log` experiment measures it for an ordinary tab.
 *
 * @typedef {{timestamp: string, kind: 'audio'|'timer'|'cpu', message: string}} LogRow
 */

/** The nominal delay, in milliseconds, of the recurring timer-drift check. */
const TIMER_NOMINAL_INTERVAL_MS = 1000;
/** Loop iterations per CPU benchmark run, identical to the other idle-time experiments' so all are directly comparable. */
const CPU_BENCHMARK_ITERATIONS = 15_000_000;
/** The largest number of log rows kept in storage at once, oldest dropped first. */
const MAX_LOG_ROWS = 500;
/** The chrome.storage.local key the log is kept under, read by popup.js. */
const STORAGE_KEY = 'idleExperimentLog';
/** The gain applied to the tone; see the sibling silent_audio_log experiment for why this is not zero. */
const TONE_GAIN = 0.001;
/** Near the bottom of the range of human hearing, chosen to keep the tone as unobtrusive as possible. */
const TONE_FREQUENCY_HZ = 30;

class Offscreen {
	/** The log kept in memory; chrome.storage.local is a mirror of this, not the source of truth. */
	static logRows = [];

	/** Starts the tone and every measurement. */
	static async start() {
		Offscreen.startTone();
		await Offscreen.appendRow('audio', 'quiet tone started in the offscreen document');
		Offscreen.loopCpuBenchmark();
		Offscreen.scheduleTimerTick();
	}

	/** Starts a very quiet, continuous tone, which is what keeps this document classified as playing audio. */
	static startTone() {
		const audioContext = new AudioContext();
		const oscillator = audioContext.createOscillator();
		const gain = audioContext.createGain();
		oscillator.frequency.value = TONE_FREQUENCY_HZ;
		gain.gain.value = TONE_GAIN;
		oscillator.connect(gain);
		gain.connect(audioContext.destination);
		oscillator.start();
	}

	/**
	 * Runs the fixed CPU workload back to back, reporting each run's duration.
	 *
	 * Continuing through a microtask rather than a timer is what makes this a measurement of raw
	 * throughput rather than of timer scheduling, which {@link scheduleTimerTick} already covers.
	 */
	static loopCpuBenchmark() {
		const startedAt = performance.now();
		let accumulator = 0;
		for (let index = 0; index < CPU_BENCHMARK_ITERATIONS; index += 1) {
			accumulator += Math.sqrt(index) % 7;
		}
		// Reading `accumulator` through a condition that never holds is what stops the loop above
		// from being optimized away as dead code, since nothing else uses its result.
		if (accumulator === Number.NEGATIVE_INFINITY) console.log(accumulator);
		const durationMs = performance.now() - startedAt;
		void Offscreen.appendRow('cpu', `fixed ${CPU_BENCHMARK_ITERATIONS.toLocaleString()}-iteration loop took ${durationMs.toFixed(1)} ms`);
		void Promise.resolve().then(() => Offscreen.loopCpuBenchmark());
	}

	/** Fires roughly once a second and reports how far this document's own timer drifted. */
	static scheduleTimerTick() {
		const scheduledAt = performance.now();
		setTimeout(() => {
			const actualDelayMs = performance.now() - scheduledAt;
			const driftMs = actualDelayMs - TIMER_NOMINAL_INTERVAL_MS;
			const driftText = `${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(0)} ms`;
			void Offscreen.appendRow('timer', `${TIMER_NOMINAL_INTERVAL_MS} ms timer fired after ${actualDelayMs.toFixed(0)} ms (drift ${driftText})`);
			Offscreen.scheduleTimerTick();
		}, TIMER_NOMINAL_INTERVAL_MS);
	}

	/**
	 * Appends one row to the in-memory log, trims it to {@link MAX_LOG_ROWS}, and mirrors the
	 * full array to chrome.storage.local for popup.js to read.
	 *
	 * The in-memory array is the source of truth and is mutated synchronously, so two calls
	 * started close together cannot race on it even though the storage write is asynchronous;
	 * at worst one storage write finishes after another and simply persists the fuller log.
	 *
	 * @param {LogRow['kind']} kind
	 * @param {string} message
	 */
	static async appendRow(kind, message) {
		Offscreen.logRows.push({ timestamp: new Date().toISOString(), kind, message });
		if (Offscreen.logRows.length > MAX_LOG_ROWS) Offscreen.logRows = Offscreen.logRows.slice(-MAX_LOG_ROWS);
		await chrome.storage.local.set({ [STORAGE_KEY]: Offscreen.logRows });
	}
}

void Offscreen.start();
