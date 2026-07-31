import { IdleProbe, type IdlePageState } from './idle_probe';
import { UiHelper } from './ui_helper';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MainHelper — builds the page and starts every measurement
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The largest number of log rows kept on screen at once, oldest dropped first. */
const MAX_LOG_ROWS = 500;

/** Builds the page, wires it to {@link IdleProbe}, and starts measuring. */
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
      <p class="eyebrow">Idle-time experiment / 01</p>
      <h1>Visibility &amp; timer<br /><em>calibration log</em></h1>
      <p class="intro">This page measures itself. It logs every visibility and focus change, how far its own
        1-second timer drifts from 1 second, how many animation frames land between ticks, and how long a fixed
        amount of raw computation takes — once a second, for as long as the page stays open.</p>
    </section>
    <div class="status-bar">
      <span class="badge" id="badge-visibility"><i></i><span>Checking visibility</span></span>
      <span class="badge" id="badge-focus"><i></i><span>Checking focus</span></span>
    </div>
    <section class="panel">
      <h2>How to use this page</h2>
      <ol>
        <li>Leave this tab as it is for about 30 seconds and watch the log below settle into a steady rhythm.</li>
        <li>Move this window to a corner of the screen, small and not covered by anything else, then work in a
          different window that does not overlap it. Do not click back into this window.</li>
        <li>Come back after a minute or two and read the log: did the timer drift, the animation-frame count, or
          the CPU benchmark time change once the window lost focus but stayed visible?</li>
        <li>Repeat with this window fully covered by another window, and again minimized, to see whether either of
          those produces a different pattern from an unfocused-but-visible window.</li>
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
	}

	/** Reflects the tab's current visibility and focus in the two status badges. */
	private static renderState(state: IdlePageState, visibilityBadgeEl: HTMLElement, focusBadgeEl: HTMLElement): void {
		UiHelper.setBadge(visibilityBadgeEl, `Visibility: ${state.visibility}`, state.visibility === 'visible' ? 'good' : 'bad');
		UiHelper.setBadge(focusBadgeEl, state.isFocused ? 'Focus: focused' : 'Focus: unfocused', state.isFocused ? 'good' : 'warn');
	}
}

MainHelper.main();
