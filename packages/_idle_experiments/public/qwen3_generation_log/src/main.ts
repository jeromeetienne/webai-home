import { ModelHelper } from './model_helper';
import { IdleProbe, type IdlePageState } from './idle_probe';
import { UiHelper } from './ui_helper';
import { AudioKeepalive, type AudioKeepaliveState } from './audio_keepalive';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MainHelper — builds the page, loads the model, and runs generation on a loop
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The largest number of log rows kept on screen at once, oldest dropped first. */
const MAX_LOG_ROWS = 500;

/** How often the tone's own state is checked for a change worth logging. */
const AUDIO_STATE_POLL_INTERVAL_MS = 2000;

/**
 * The prompt every generation cycle uses.
 *
 * Fixed and short on purpose: this experiment measures how generation timing changes as the
 * tab's visibility changes, so the workload itself needs to stay identical from one cycle to
 * the next.
 */
const FIXED_PROMPT = 'Explain in one short sentence why running a language model in the browser can be useful.';

/** Running totals shown in the stats panel. */
type RunningStats = {
	generationCount: number;
	totalDurationMs: number;
	totalTokens: number;
};

/** Builds the page, loads the model, and starts the generation loop. */
class MainHelper {
	private static logBodyEl: HTMLTableSectionElement;
	private static visibilityBadgeEl: HTMLElement;
	private static focusBadgeEl: HTMLElement;
	private static backendBadgeEl: HTMLElement;
	private static generationCountEl: HTMLElement;
	private static averageRateEl: HTMLElement;
	private static lastDurationEl: HTMLElement;
	private static audioBadgeEl: HTMLElement;
	private static lastAudioState: AudioKeepaliveState = 'stopped';

	/** Builds the page, wires it up, loads the model, and starts generating. */
	static main(): void {
		const app = document.querySelector<HTMLElement>('#app');
		if (app === null) throw new Error('The page must contain an #app element.');

		app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <a class="back-link" href="../">← All experiments</a>
    </header>
    <section class="hero">
      <p class="eyebrow">Idle-time experiment / 02</p>
      <h1>Qwen3-0.6B<br /><em>generation log</em></h1>
      <p class="intro">This page loads Qwen3-0.6B-ONNX once, then generates a short answer to the same fixed prompt over
        and over, forever. Each cycle is logged with how long it took, this tab's visibility and focus at the time, and
        whether the quiet tone was playing, so a long-running session shows whether generation speed changes once the
        tab is hidden — and whether the quiet tone from experiment 04 brings that speed back.</p>
    </section>
    <div class="status-bar">
      <span class="badge" id="badge-visibility"><i></i><span>Checking visibility</span></span>
      <span class="badge" id="badge-focus"><i></i><span>Checking focus</span></span>
      <span class="badge" id="badge-backend"><i></i><span>Checking backend</span></span>
      <span class="badge" id="badge-audio"><i></i><span>Audio: stopped</span></span>
    </div>
    <section class="panel">
      <div class="stats-grid">
        <div class="stat"><span>Generations run</span><strong id="stat-count">0</strong></div>
        <div class="stat"><span>Average rate</span><strong id="stat-rate">—</strong></div>
        <div class="stat"><span>Last duration</span><strong id="stat-duration">—</strong></div>
      </div>
    </section>
    <section class="panel">
      <h2>How to use this page</h2>
      <ol>
        <li>Leave this tab on screen for a minute and note the tokens-per-second figure the log settles on. This is
          the baseline every later reading is compared against.</li>
        <li>Switch to another tab, or another window that fully covers this one, and leave it there for a minute.
          Come back and read the rows logged while this tab was hidden, with the tone still stopped.</li>
        <li>Click "Start quiet tone" below, then hide this tab again for another minute. Browsers require a click
          before they allow audio to start, so this cannot happen automatically on page load.</li>
        <li>Compare the three groups of rows. Every row records the visibility and the tone state it was measured
          under, so the log can be read back without keeping notes: hidden rows with the tone stopped against
          hidden rows with the tone running is the comparison this page exists to make.</li>
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
    <footer><span>No server, no dependency on the rest of this repository.</span><span>Local inference only</span></footer>
  </main>
`;

		MainHelper.logBodyEl = UiHelper.getElement<HTMLTableSectionElement>('#log-body');
		MainHelper.visibilityBadgeEl = UiHelper.getElement<HTMLElement>('#badge-visibility');
		MainHelper.focusBadgeEl = UiHelper.getElement<HTMLElement>('#badge-focus');
		MainHelper.backendBadgeEl = UiHelper.getElement<HTMLElement>('#badge-backend');
		MainHelper.generationCountEl = UiHelper.getElement<HTMLElement>('#stat-count');
		MainHelper.averageRateEl = UiHelper.getElement<HTMLElement>('#stat-rate');
		MainHelper.lastDurationEl = UiHelper.getElement<HTMLElement>('#stat-duration');
		MainHelper.audioBadgeEl = UiHelper.getElement<HTMLElement>('#badge-audio');
		const startAudioButtonEl = UiHelper.getElement<HTMLButtonElement>('#start-audio-button');

		IdleProbe.start(
			(row) => UiHelper.appendLogRow(MainHelper.logBodyEl, row, MAX_LOG_ROWS),
			(state) => MainHelper.renderState(state),
		);

		startAudioButtonEl.addEventListener('click', () => {
			AudioKeepalive.start();
			startAudioButtonEl.disabled = true;
			startAudioButtonEl.textContent = 'Quiet tone running';
			MainHelper.pollAudioState();
		});

		void MainHelper.loadAndRun();
	}

	/** Checks the tone's state, logs it if it changed, and reflects it in the audio badge. */
	private static pollAudioState(): void {
		const state = AudioKeepalive.state();
		if (state !== MainHelper.lastAudioState) {
			MainHelper.lastAudioState = state;
			UiHelper.appendLogRow(
				MainHelper.logBodyEl,
				{
					timestamp: IdleProbe.now(),
					kind: 'audio',
					message: `tone is now "${state}"`,
				},
				MAX_LOG_ROWS,
			);
		}
		UiHelper.setBadge(MainHelper.audioBadgeEl, `Audio: ${state}`, state === 'running' ? 'good' : 'warn');
		setTimeout(() => MainHelper.pollAudioState(), AUDIO_STATE_POLL_INTERVAL_MS);
	}

	/** Loads the model, then runs generation cycles one after another for as long as the page is open. */
	private static async loadAndRun(): Promise<void> {
		UiHelper.appendLogRow(MainHelper.logBodyEl, { timestamp: IdleProbe.now(), kind: 'status', message: 'Loading the model…' }, MAX_LOG_ROWS);
		try {
			await ModelHelper.loadModel((message) => UiHelper.appendLogRow(MainHelper.logBodyEl, { timestamp: IdleProbe.now(), kind: 'status', message }, MAX_LOG_ROWS));
		} catch (error: unknown) {
			UiHelper.appendLogRow(MainHelper.logBodyEl, { timestamp: IdleProbe.now(), kind: 'status', message: `Model failed to load: ${error instanceof Error ? error.message : String(error)}` }, MAX_LOG_ROWS);
			return;
		}
		UiHelper.setBadge(MainHelper.backendBadgeEl, `Backend: ${ModelHelper.currentBackend()}`, 'neutral');

		const stats: RunningStats = { generationCount: 0, totalDurationMs: 0, totalTokens: 0 };
		for (;;) {
			const stateAtStart = IdleProbe.currentState();
			const audioStateAtStart = AudioKeepalive.state();
			const result = await ModelHelper.generate(FIXED_PROMPT);
			const stateAtEnd = IdleProbe.currentState();
			MainHelper.recordGeneration(stats, stateAtStart, stateAtEnd, audioStateAtStart, result.durationMs, result.tokenCount);
		}
	}

	/**
	 * Logs one finished generation and updates the running stats panel.
	 *
	 * @param stats The running totals shown in the stats panel, updated in place.
	 * @param stateAtStart The tab's visibility and focus when this generation started.
	 * @param stateAtEnd The tab's visibility and focus when this generation finished.
	 * @param audioStateAtStart Whether the quiet tone was playing when this generation started.
	 * @param durationMs How long this generation took, in milliseconds.
	 * @param tokenCount How many tokens this generation produced.
	 */
	private static recordGeneration(stats: RunningStats, stateAtStart: IdlePageState, stateAtEnd: IdlePageState, audioStateAtStart: AudioKeepaliveState, durationMs: number, tokenCount: number): void {
		stats.generationCount += 1;
		stats.totalDurationMs += durationMs;
		stats.totalTokens += tokenCount;

		const tokensPerSecond = tokenCount / (durationMs / 1000);
		const visibilityChanged = stateAtStart.visibility !== stateAtEnd.visibility || stateAtStart.isFocused !== stateAtEnd.isFocused;
		const stateText = visibilityChanged
			? `visibility "${stateAtStart.visibility}"/${stateAtStart.isFocused ? 'focused' : 'unfocused'} at start, "${stateAtEnd.visibility}"/${stateAtEnd.isFocused ? 'focused' : 'unfocused'} at end`
			: `visibility "${stateAtStart.visibility}", ${stateAtStart.isFocused ? 'focused' : 'unfocused'}`;
		UiHelper.appendLogRow(
			MainHelper.logBodyEl,
			{
				timestamp: IdleProbe.now(),
				kind: 'generation',
				message: `#${stats.generationCount}: ${tokenCount} tokens in ${(durationMs / 1000).toFixed(2)} s (${tokensPerSecond.toFixed(1)} tok/s), ${stateText}, tone "${audioStateAtStart}"`,
			},
			MAX_LOG_ROWS,
		);

		MainHelper.generationCountEl.textContent = String(stats.generationCount);
		MainHelper.averageRateEl.textContent = `${(stats.totalTokens / (stats.totalDurationMs / 1000)).toFixed(1)} tok/s`;
		MainHelper.lastDurationEl.textContent = `${(durationMs / 1000).toFixed(2)} s`;
	}

	/** Reflects the tab's current visibility and focus in the two status badges. */
	private static renderState(state: IdlePageState): void {
		UiHelper.setBadge(MainHelper.visibilityBadgeEl, `Visibility: ${state.visibility}`, state.visibility === 'visible' ? 'good' : 'bad');
		UiHelper.setBadge(MainHelper.focusBadgeEl, state.isFocused ? 'Focus: focused' : 'Focus: unfocused', state.isFocused ? 'good' : 'warn');
	}
}

MainHelper.main();
