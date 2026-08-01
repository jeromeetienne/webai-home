import type { WorkerReport } from './worker_protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CpuWorker — runs the fixed CPU benchmark and a 1-second timer-drift check on
//	a dedicated worker thread, independently of the main thread and its document
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Identical in method to `web_worker_cpu_log/src/cpu_worker.ts`, kept as its own copy so this
 * experiment's worker-thread measurement is taken exactly the same way, independently of the
 * main-thread tone {@link AudioKeepalive} plays at the same time.
 */

/** Loop iterations per benchmark run, identical to `idle_probe.ts`'s so the two are directly comparable. */
const CPU_BENCHMARK_ITERATIONS = 15_000_000;
/** The nominal delay, in milliseconds, of this worker's own timer-drift check. */
const TIMER_NOMINAL_INTERVAL_MS = 1000;

/**
 * The narrow part of the worker global scope this file uses, cast in explicitly.
 *
 * The "webworker" and "DOM" type libraries cannot both be loaded in one TypeScript project, and
 * this project's shared tsconfig already loads "DOM" for the page-side experiment files. Casting
 * `globalThis` to just the one method this file calls avoids that conflict without needing a
 * second tsconfig.
 */
type WorkerScope = {
	postMessage(message: WorkerReport): void;
};

/** Runs the CPU benchmark loop and the timer-drift check, and reports every result. */
class CpuWorker {
	private static readonly scope = globalThis as unknown as WorkerScope;

	/** Starts both measurements. Neither waits for the other. */
	static start(): void {
		CpuWorker.loopCpuBenchmark();
		CpuWorker.scheduleTimerTick();
	}

	/**
	 * Runs the fixed CPU workload back to back, reporting each run's duration.
	 *
	 * Continuing through a microtask rather than a timer is what makes this a measurement of raw
	 * throughput rather than of timer scheduling, which {@link scheduleTimerTick} already covers.
	 */
	private static loopCpuBenchmark(): void {
		const startedAt = performance.now();
		let accumulator = 0;
		for (let index = 0; index < CPU_BENCHMARK_ITERATIONS; index += 1) {
			accumulator += Math.sqrt(index) % 7;
		}
		// Reading `accumulator` through a condition that never holds is what stops the loop above
		// from being optimized away as dead code, since nothing else uses its result.
		if (accumulator === Number.NEGATIVE_INFINITY) console.log(accumulator);
		CpuWorker.scope.postMessage({ kind: 'worker-cpu', durationMs: performance.now() - startedAt });
		void Promise.resolve().then(() => CpuWorker.loopCpuBenchmark());
	}

	/** Fires roughly once a second and reports how far this worker's own timer drifted. */
	private static scheduleTimerTick(): void {
		const scheduledAt = performance.now();
		setTimeout(() => {
			const actualDelayMs = performance.now() - scheduledAt;
			CpuWorker.scope.postMessage({ kind: 'worker-timer', actualDelayMs, driftMs: actualDelayMs - TIMER_NOMINAL_INTERVAL_MS });
			CpuWorker.scheduleTimerTick();
		}, TIMER_NOMINAL_INTERVAL_MS);
	}
}

CpuWorker.start();
