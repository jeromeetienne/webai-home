///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	PageMarkup — prepares text for display inside the markup a page builds
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Turns values into text that is safe and readable inside page markup. */
export class PageMarkup {
	/**
	 * Escapes text so it can be placed inside markup.
	 *
	 * @param value The text to escape.
	 * @returns The text with every character that has meaning in markup replaced.
	 */
	static escapeHtml(value: string): string {
		return value
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#039;');
	}

	/**
	 * Writes a timestamp as a local time of day.
	 *
	 * @param timestamp The moment, as ISO 8601 text.
	 * @returns The time of day in the reader's own locale.
	 */
	static formatTime(timestamp: string): string {
		return new Date(timestamp).toLocaleTimeString();
	}
}
