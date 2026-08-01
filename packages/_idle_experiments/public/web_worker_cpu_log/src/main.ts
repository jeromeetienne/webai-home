import { IdleProbe, type IdlePageState, type LogRow } from './idle_probe';
import { UiHelper } from './ui_helper';
import type { WorkerReport } from './worker_protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MainHelper — builds the page, starts the main-thread probe and the CPU
//	worker, and merges both into one log
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The largest number of log rows kept on screen at once, oldest dropped first. */
const MAX_LOG_ROWS = 500;

/** Builds the page and starts both the main-thread and worker-thread measurements. */
class MainHelper {
	/**
	 * Builds the page and starts every measurement. Nothing after this needs a click: the whole
	 * point is to start it, move the tab around, and read the log afterwards.
	 */
	static main(): void {
		const app = document.querySelector<HTMLElement>('#app');
		if (app === null) throw new Error('The page must contain an #app element.');

		app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <a class="back-link" href="../">← All experiments</a>
    </header>
    <section class="hero">
      <p class="eyebrow">Idle-time experiment / 03</p>
      <h1>Web Worker<br /><em>CPU offload log</em></h1>
      <p class="intro">This page runs the exact same fixed CPU workload from experiment 01, at the same time, on both
        the main thread and on a dedicated Web Worker thread. Both report their own throughput and their own
        1-second timer drift into this one log, so they can be compared directly under identical backgrounding
        conditions. If the worker's numbers stay steady while the main thread's degrade, offloading heavy
        computation to a Worker is a real mitigation worth building into the production worker page.</p>
    </section>
    <div class="status-bar">
      <span class="badge" id="badge-visibility"><i></i><span>Checking visibility</span></span>
      <span class="badge" id="badge-focus"><i></i><span>Checking focus</span></span>
    </div>
    <section class="panel">
      <h2>How to use this page</h2>
      <ol>
        <li>Leave this tab as it is for about 30 seconds and watch the log settle into a steady rhythm, with rows
          from both "cpu"/"timer" (main thread) and "worker-cpu"/"worker-timer" (the Worker) interleaved.</li>
        <li>Move this window to a corner of the screen, small and not covered by anything else, then work in a
          different window that does not overlap it, without clicking back into this window.</li>
        <li>Come back after a minute or two and compare: did "cpu" and "worker-cpu" durations move together, or did
          one stay flat while the other grew?</li>
        <li>Repeat with the window fully covered or minimized to compare against a truly backgrounded tab.</li>
      </ol>
    </section>
    <section class="panel log-panel">
      <h2>Log</h2>
      <div class="log-table-wrap">
        <table class="log-table">
          <thead><tr><th>Time</th><th>Kind</th><th>Measurement</th></tr></thead>
          <tbody id="log-body"></tbody>
        </table>
      </div>
    </section>
    <footer><span>No model, no server, no dependency on the rest of this repository.</span><span>Local measurement only</span></footer>
  </main>
`;

		const logBodyEl = UiHelper.getElement<HTMLTableSectionElement>('#log-body');
		const visibilityBadgeEl = UiHelper.getElement<HTMLElement>('#badge-visibility');
		const focusBadgeEl = UiHelper.getElement<HTMLElement>('#badge-focus');

		IdleProbe.start(
			(row) => UiHelper.appendLogRow(logBodyEl, row, MAX_LOG_ROWS),
			(state) => MainHelper.renderState(state, visibilityBadgeEl, focusBadgeEl),
		);

		MainHelper.startWorker((row) => UiHelper.appendLogRow(logBodyEl, row, MAX_LOG_ROWS));
	}

	/** Starts the CPU worker and turns every report it posts into a log row. */
	private static startWorker(onLogRow: (row: LogRow) => void): void {
		const worker = new Worker(new URL('./cpu_worker.ts', import.meta.url), { type: 'module' });
		worker.addEventListener('message', (event: MessageEvent<WorkerReport>) => {
			const report = event.data;
			const message = report.kind === 'worker-cpu'
				? `fixed 15,000,000-iteration loop took ${report.durationMs.toFixed(1)} ms`
				: `1000 ms timer fired after ${report.actualDelayMs.toFixed(0)} ms (drift ${report.driftMs >= 0 ? '+' : ''}${report.driftMs.toFixed(0)} ms)`;
			onLogRow({ timestamp: new Date().toISOString(), kind: report.kind, message });
		});
	}

	/** Reflects the tab's current visibility and focus in the two status badges. */
	private static renderState(state: IdlePageState, visibilityBadgeEl: HTMLElement, focusBadgeEl: HTMLElement): void {
		UiHelper.setBadge(visibilityBadgeEl, `Visibility: ${state.visibility}`, state.visibility === 'visible' ? 'good' : 'bad');
		UiHelper.setBadge(focusBadgeEl, state.isFocused ? 'Focus: focused' : 'Focus: unfocused', state.isFocused ? 'good' : 'warn');
	}
}

MainHelper.main();
