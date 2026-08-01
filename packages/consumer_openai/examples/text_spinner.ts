///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TextSpinner — writes a spinning character on the terminal while waiting
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * A small terminal spinner. It rewrites the same column of the terminal with a
 * changing character, so the user can see that the program is still waiting for
 * an answer.
 */
export class TextSpinner {
	/** Identifier of the repeating timer, or `null` when the spinner is stopped. */
	private _intervalId: NodeJS.Timeout | null = null;

	/** Index of the next character to write, inside `_charSequence`. */
	private _counter: number = 0;

	/** The characters written one after the other to give the impression of a spin. */
	private _charSequence: string[] = ['|', '/', '-', '\\'];

	/**
	 * Stops the spinner and releases its timer.
	 * @returns nothing
	 */
	destroy(): void {
		this.stop();
	}

	/**
	 * Starts writing the spinning character, one change every 100 milliseconds.
	 * @returns nothing
	 */
	start(): void {
		console.assert(this._intervalId === null);
		this._displayChar();
		this._intervalId = setInterval(() => {
			this._displayChar();
		}, 100);
	}

	/**
	 * Stops writing the spinning character. Doing this on a stopped spinner has no effect.
	 * @returns nothing
	 */
	stop(): void {
		if (this._intervalId !== null) {
			clearInterval(this._intervalId);
			this._intervalId = null;
		}
	}

	/**
	 * Writes the next character of the sequence, followed by a carriage return so the
	 * next write lands on the same column.
	 * @returns nothing
	 */
	private _displayChar(): void {
		const text = this._charSequence[this._counter] + '\r';
		process.stdout.write(text);
		this._counter += 1;
		this._counter %= this._charSequence.length;
	}
}
