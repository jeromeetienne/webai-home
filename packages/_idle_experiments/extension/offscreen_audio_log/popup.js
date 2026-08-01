///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Popup — displays the log kept by offscreen.js; takes no measurement itself
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** @typedef {{timestamp: string, kind: 'audio'|'timer'|'cpu', message: string}} LogRow */

/** The chrome.storage.local key the log is kept under, written by offscreen.js. */
const STORAGE_KEY = 'idleExperimentLog';

class Popup {
	/** Renders the log currently in storage, then keeps re-rendering it as offscreen.js updates it. */
	static async start() {
		const logBodyEl = /** @type {HTMLTableSectionElement} */ (document.querySelector('#log-body'));
		if (logBodyEl === null) throw new Error('The popup must contain a #log-body element.');

		const stored = await chrome.storage.local.get(STORAGE_KEY);
		Popup.render(logBodyEl, /** @type {LogRow[] | undefined} */ (stored[STORAGE_KEY]) ?? []);

		chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
			Popup.render(logBodyEl, /** @type {LogRow[]} */ (changes[STORAGE_KEY].newValue ?? []));
		});
	}

	/**
	 * Replaces the log table's contents with the given rows. Only re-pins the scroll position to
	 * the newest row when the table was already scrolled to (or near) the bottom, so reading an
	 * earlier row is not interrupted by new rows arriving.
	 *
	 * @param {HTMLTableSectionElement} logBodyEl
	 * @param {LogRow[]} rows
	 */
	static render(logBodyEl, rows) {
		const wrapEl = logBodyEl.closest('.log-table-wrap');
		const wasNearBottom = wrapEl !== null && wrapEl.scrollHeight - wrapEl.scrollTop - wrapEl.clientHeight < 24;
		logBodyEl.innerHTML = rows.map((row) => `<tr class="log-row kind-${row.kind}"><td class="time">${Popup.formatTime(row.timestamp)}</td><td class="kind">${row.kind}</td><td class="message">${Popup.escapeHtml(row.message)}</td></tr>`).join('');
		if (wrapEl !== null && wasNearBottom) wrapEl.scrollTop = wrapEl.scrollHeight;
	}

	/** @param {string} isoTimestamp */
	static formatTime(isoTimestamp) {
		return isoTimestamp.slice(11, 23);
	}

	/** @param {string} text */
	static escapeHtml(text) {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
}

void Popup.start();
