import { IdleProbe, type IdlePageState, type LogRow } from './idle_probe';
import { UiHelper } from './ui_helper';
import { AudioKeepalive, type AudioKeepaliveState } from './audio_keepalive';
import type { WorkerReport } from './worker_protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MainHelper — builds the page, starts the main-thread probe and the CPU
//	worker, and wires up the tone, so all three run together
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The largest number of log rows kept on screen at once, oldest dropped first. */
const MAX_LOG_ROWS = 500;

/** How often the tone's own state is checked for a change worth logging. */
const AUDIO_STATE_POLL_INTERVAL_MS = 2000;

/** Builds the page and starts the main-thread probe, the CPU worker, and the tone's button. */
class MainHelper {
	private static logBodyEl: HTMLTableSectionElement;
	private static audioBadgeEl: HTMLElement;
	private static lastAudioState: AudioKeepaliveState = 'stopped';

	/** Builds the page and starts every measurement other than the tone, which needs a click. */
	static main(): void {
		const app = document.querySelector<HTMLElement>('#app');
		if (app === null) throw new Error('The page must contain an #app element.');

		app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <a class="back-link" href="../">← All experiments</a>
    </header>
    <section class="hero">
      <p class="eyebrow">Idle-time experiment / 07</p>
      <h1>Worker + audio<br /><em>combo log</em></h1>
      <p class="intro">Experiment 03 offloads computation to a Web Worker. Experiment 04 keeps a tab producing a
        quiet, continuous tone. Neither replaces the other: the worker keeps computation itself off the throttled
        main thread, while the tone is a signal to the browser's own backgrounding heuristics. This page runs both
        at once, so their effect can be read together rather than compared page by page. Everything below is
        identical in method to those two experiments — this page adds nothing new to what is measured, only that
        both mitigations are active together.</p>
    </section>
    <div class="status-bar">
      <span class="badge" id="badge-visibility"><i></i><span>Checking visibility</span></span>
      <span class="badge" id="badge-focus"><i></i><span>Checking focus</span></span>
      <span class="badge" id="badge-audio"><i></i><span>Audio: stopped</span></span>
    </div>
    <section class="panel">
      <h2>How to use this page</h2>
      <ol>
        <li>Click "Start quiet tone" below. Browsers require a click before they allow audio to start, so this
          cannot happen automatically on page load.</li>
        <li>Leave this tab as it is for about 30 seconds and watch the log settle into a steady rhythm, with rows
          from "cpu"/"timer" (main thread), "worker-cpu"/"worker-timer" (the Worker), and "audio" (the tone)
          interleaved.</li>
        <li>Move this window to a corner of the screen, small and not covered by anything else, then work in a
          different window that does not overlap it, without clicking back into this window.</li>
        <li>Come back after a minute or two and compare against experiment 03's log (worker alone) and experiment
          04's log (tone alone) taken under the same conditions, to see whether combining them helps beyond either
          one on its own.</li>
      </ol>
      <div class="controls">
        <button id="start-audio-button" type="button">Start quiet tone</button>
      </div>
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

		MainHelper.logBodyEl = UiHelper.getElement<HTMLTableSectionElement>('#log-body');
		MainHelper.audioBadgeEl = UiHelper.getElement<HTMLElement>('#badge-audio');
		const visibilityBadgeEl = UiHelper.getElement<HTMLElement>('#badge-visibility');
		const focusBadgeEl = UiHelper.getElement<HTMLElement>('#badge-focus');
		const startAudioButtonEl = UiHelper.getElement<HTMLButtonElement>('#start-audio-button');

		IdleProbe.start(
			(row) => UiHelper.appendLogRow(MainHelper.logBodyEl, row, MAX_LOG_ROWS),
			(state) => MainHelper.renderState(state, visibilityBadgeEl, focusBadgeEl),
		);

		MainHelper.startWorker((row) => UiHelper.appendLogRow(MainHelper.logBodyEl, row, MAX_LOG_ROWS));

		startAudioButtonEl.addEventListener('click', () => {
			AudioKeepalive.start();
			startAudioButtonEl.disabled = true;
			startAudioButtonEl.textContent = 'Quiet tone running';
			MainHelper.pollAudioState();
		});
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

	/** Checks the tone's state, logs it if it changed, and reflects it in the audio badge. */
	private static pollAudioState(): void {
		const state = AudioKeepalive.state();
		if (state !== MainHelper.lastAudioState) {
			MainHelper.lastAudioState = state;
			UiHelper.appendLogRow(MainHelper.logBodyEl, { timestamp: IdleProbe.now(), kind: 'audio', message: `tone is now "${state}"` }, MAX_LOG_ROWS);
		}
		UiHelper.setBadge(MainHelper.audioBadgeEl, `Audio: ${state}`, state === 'running' ? 'good' : 'warn');
		setTimeout(() => MainHelper.pollAudioState(), AUDIO_STATE_POLL_INTERVAL_MS);
	}

	/** Reflects the tab's current visibility and focus in the two status badges. */
	private static renderState(state: IdlePageState, visibilityBadgeEl: HTMLElement, focusBadgeEl: HTMLElement): void {
		UiHelper.setBadge(visibilityBadgeEl, `Visibility: ${state.visibility}`, state.visibility === 'visible' ? 'good' : 'bad');
		UiHelper.setBadge(focusBadgeEl, state.isFocused ? 'Focus: focused' : 'Focus: unfocused', state.isFocused ? 'good' : 'warn');
	}
}

MainHelper.main();
