import type { LogRow } from './idle_probe';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	UiHelper — page-element lookup, log-table rendering, and badge updates
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How a status badge should be colored. */
export type BadgeTone = 'good' | 'warn' | 'bad' | 'neutral';

export class UiHelper {
	/**
	 * Finds a required page element and gives it the requested element type.
	 *
	 * @param selector CSS selector for the required element.
	 * @returns The matching page element.
	 */
	static getElement<T extends HTMLElement>(selector: string): T {
		const element = document.querySelector<T>(selector);
		if (element === null) throw new Error(`The page must contain ${selector}.`);
		return element;
	}

	/**
	 * Appends one row to the log table, trimming the oldest rows once the table grows past the
	 * given limit. Only re-pins the scroll position to the newest row when the table was already
	 * scrolled to (or near) the bottom, so reading an earlier row is not interrupted by new rows.
	 *
	 * @param tableBodyEl The log table's body element.
	 * @param row The row to append.
	 * @param maxRows The largest number of rows the table keeps before dropping the oldest.
	 */
	static appendLogRow(tableBodyEl: HTMLTableSectionElement, row: LogRow, maxRows: number): void {
		const wrapEl = tableBodyEl.closest<HTMLElement>('.log-table-wrap');
		const wasNearBottom = wrapEl !== null && wrapEl.scrollHeight - wrapEl.scrollTop - wrapEl.clientHeight < 24;
		const rowEl = document.createElement('tr');
		rowEl.className = `log-row kind-${row.kind}`;
		rowEl.innerHTML = `<td class="time">${UiHelper.formatTime(row.timestamp)}</td><td class="kind">${row.kind}</td><td class="message">${UiHelper.escapeHtml(row.message)}</td>`;
		tableBodyEl.appendChild(rowEl);
		while (tableBodyEl.rows.length > maxRows) tableBodyEl.deleteRow(0);
		if (wrapEl !== null && wasNearBottom) wrapEl.scrollTop = wrapEl.scrollHeight;
	}

	/**
	 * Updates a status badge's text and color.
	 *
	 * @param badgeEl The badge element, expected to contain one child `span` for its text.
	 * @param text The text to show.
	 * @param tone The color to apply.
	 */
	static setBadge(badgeEl: HTMLElement, text: string, tone: BadgeTone): void {
		const textEl = badgeEl.querySelector('span');
		if (textEl !== null) textEl.textContent = text;
		badgeEl.classList.remove('is-good', 'is-warn', 'is-bad');
		if (tone !== 'neutral') badgeEl.classList.add(`is-${tone}`);
	}

	/** Formats an ISO timestamp as an `HH:MM:SS.mmm` clock time. */
	private static formatTime(isoTimestamp: string): string {
		return isoTimestamp.slice(11, 23);
	}

	/** Escapes text for safe insertion into HTML. */
	private static escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}
}
