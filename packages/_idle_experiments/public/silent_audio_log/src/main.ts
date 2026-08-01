import { IdleProbe, type IdlePageState } from './idle_probe';
import { UiHelper } from './ui_helper';
import { AudioKeepalive, type AudioKeepaliveState } from './audio_keepalive';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MainHelper — builds the page, starts the probe, and wires up the tone
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The largest number of log rows kept on screen at once, oldest dropped first. */
const MAX_LOG_ROWS = 500;

/** How often the tone's own state is checked for a change worth logging. */
const AUDIO_STATE_POLL_INTERVAL_MS = 2000;

/** Builds the page, starts the probe, and wires the tone's start button and state polling. */
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
      <p class="eyebrow">Idle-time experiment / 04</p>
      <h1>Silent audio<br /><em>trick log</em></h1>
      <p class="intro">A commonly suggested workaround for background-tab throttling is to keep a tab producing
        audio, even quietly, on the theory that a browser treats an audio-playing tab differently from a silent
        one. This page runs the identical timer-drift, animation-frame, and CPU-benchmark measurement as experiment
        01, with one addition: a button that starts a very quiet, continuous tone. Compare the log from this page
        with the tone running against experiment 01's log without it, under the same backgrounding conditions.</p>
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
        <li>Leave this tab as it is for about 30 seconds and watch the log settle into a steady rhythm.</li>
        <li>Move this window to a corner of the screen, small and not covered by anything else, then work in a
          different window that does not overlap it, without clicking back into this window.</li>
        <li>Come back after a minute or two and compare the timer drift and CPU benchmark rows against experiment
          01's log taken under the same conditions without the tone.</li>
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

		startAudioButtonEl.addEventListener('click', () => {
			AudioKeepalive.start();
			startAudioButtonEl.disabled = true;
			startAudioButtonEl.textContent = 'Quiet tone running';
			MainHelper.pollAudioState();
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
