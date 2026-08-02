///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GeneratedText — decides how much of an answer may be reported as it is written
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The character a decoder writes in place of bytes that do not yet spell a character.
 *
 * A model produces text as tokens, and a token is not a character: one character can be
 * written across two tokens. Until the token that finishes such a character arrives, decoding
 * what has been generated so far puts this character where that character will be.
 */
const UNFINISHED_CHARACTER = '�';

/**
 * Decides how much of an answer a device may report while it is still writing it.
 *
 * A device that generates an answer in rounds decodes the whole answer each round and reports
 * what it has gained. That works because reporting is one-way — a reader shown text cannot be
 * shown that the text was wrong — and it holds only while each round's answer starts with the
 * one before it.
 *
 * The end of an answer breaks that rule while a character is unfinished. Decoding puts a
 * placeholder where the character will be, and the round that finishes the character replaces
 * the placeholder rather than adding after it. Reporting the placeholder would mean reporting
 * something that has to be taken back. So the unfinished end is held back, and the round that
 * finishes the character reports the whole character at once. This is not an unusual case: it
 * is what happens to every accented letter, every character of most languages not written in
 * the Latin alphabet, and every emoji.
 */
export class GeneratedText {
	/**
	 * Works out how much of an answer may be reported now.
	 *
	 * @param reportedText The answer as far as it has already been reported.
	 * @param wholeText The answer as it now stands, unfinished characters and all.
	 * @returns How much of the answer may be reported, of which whatever is beyond
	 * `reportedText` is this round's new text. Never shorter than what was already reported, so
	 * nothing already reported is ever taken back.
	 */
	static reportable(reportedText: string, wholeText: string): string {
		let end = wholeText.length;
		while (end > 0 && wholeText[end - 1] === UNFINISHED_CHARACTER) end -= 1;
		const settled = wholeText.slice(0, end);
		// If the settled answer is somehow not a continuation of what was reported, nothing new is
		// reported this round. The answer carried by the result that ends the task is what puts a
		// reader right, because that one is the whole answer rather than an account of how it grew.
		if (settled.startsWith(reportedText) === false) return reportedText;
		return settled;
	}

	/**
	 * Works out what one round adds to what has already been reported.
	 *
	 * @param reportedText The answer as far as it has already been reported.
	 * @param reportableText How much of the answer may be reported now, from
	 * {@link GeneratedText.reportable}.
	 * @returns The new text this round produced, which is empty when it produced none.
	 */
	static addition(reportedText: string, reportableText: string): string {
		if (reportableText.startsWith(reportedText) === false) return '';
		return reportableText.slice(reportedText.length);
	}
}
