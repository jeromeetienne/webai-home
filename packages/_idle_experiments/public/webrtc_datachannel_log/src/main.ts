import { IdleProbe, type IdlePageState } from './idle_probe';
import { UiHelper } from './ui_helper';
import { WebrtcLoopback, type WebrtcState } from './webrtc_loopback';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MainHelper — builds the page, starts the probe, and starts the loopback
//	WebRTC data channel
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The largest number of log rows kept on screen at once, oldest dropped first. */
const MAX_LOG_ROWS = 500;

/** Builds the page and starts both the calibration probe and the loopback data channel. */
class MainHelper {
	/** Builds the page and starts every measurement. Nothing after this needs a click. */
	static main(): void {
		const app = document.querySelector<HTMLElement>('#app');
		if (app === null) throw new Error('The page must contain an #app element.');

		app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <a class="back-link" href="../">← All experiments</a>
    </header>
    <section class="hero">
      <p class="eyebrow">Idle-time experiment / 06</p>
      <h1>WebRTC data channel<br /><em>trick log</em></h1>
      <p class="intro">Chrome documents "real-time connections (WebSockets and WebRTC)" as exempt from
        background-tab timer throttling, alongside audio playback. This page opens two <code>RTCPeerConnection</code>s
        that connect only to each other, in this same page — no signaling server needed, since both sides can reach
        each other directly over localhost — and keeps a data channel open between them with one ping a second. It
        runs the identical timer-drift, animation-frame, and CPU-benchmark measurement as experiment 01 alongside it,
        so the two can be compared directly.</p>
    </section>
    <div class="status-bar">
      <span class="badge" id="badge-visibility"><i></i><span>Checking visibility</span></span>
      <span class="badge" id="badge-focus"><i></i><span>Checking focus</span></span>
      <span class="badge" id="badge-webrtc"><i></i><span>WebRTC: connecting</span></span>
    </div>
    <section class="panel">
      <h2>How to use this page</h2>
      <ol>
        <li>Leave this tab as it is for about 30 seconds and watch the log settle into a steady rhythm, including a
          "ping round trip" row roughly once a second.</li>
        <li>Move this window to a corner of the screen, small and not covered by anything else, then work in a
          different window that does not overlap it, without clicking back into this window.</li>
        <li>Come back after a minute or two and compare the timer drift and CPU benchmark rows against experiment
          01's log taken under the same conditions without the data channel.</li>
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
		const webrtcBadgeEl = UiHelper.getElement<HTMLElement>('#badge-webrtc');

		IdleProbe.start(
			(row) => UiHelper.appendLogRow(logBodyEl, row, MAX_LOG_ROWS),
			(state) => MainHelper.renderPageState(state, visibilityBadgeEl, focusBadgeEl),
		);

		void WebrtcLoopback.start(
			(message) => UiHelper.appendLogRow(logBodyEl, { timestamp: IdleProbe.now(), kind: 'webrtc', message }, MAX_LOG_ROWS),
			(state) => MainHelper.renderWebrtcState(state, webrtcBadgeEl),
		);
	}

	/** Reflects the tab's current visibility and focus in the two status badges. */
	private static renderPageState(state: IdlePageState, visibilityBadgeEl: HTMLElement, focusBadgeEl: HTMLElement): void {
		UiHelper.setBadge(visibilityBadgeEl, `Visibility: ${state.visibility}`, state.visibility === 'visible' ? 'good' : 'bad');
		UiHelper.setBadge(focusBadgeEl, state.isFocused ? 'Focus: focused' : 'Focus: unfocused', state.isFocused ? 'good' : 'warn');
	}

	/** Reflects the loopback data channel's current state in its badge. */
	private static renderWebrtcState(state: WebrtcState, webrtcBadgeEl: HTMLElement): void {
		UiHelper.setBadge(webrtcBadgeEl, `WebRTC: ${state}`, state === 'open' ? 'good' : state === 'connecting' ? 'warn' : 'bad');
	}
}

MainHelper.main();
