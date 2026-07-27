/** Provides shared page-element lookup and status-message helpers. */
export class UiHelper {
	/**
	 * Finds a required page element and gives it the requested element type.
	 *
	 * @param selector CSS selector for the required element.
	 * @returns The matching page element.
	 */
	static getElement<T extends HTMLElement>(selector: string): T {
		const element = document.querySelector<T>(selector);
		if (!element) throw new Error(`The page must contain ${selector}.`);
		return element;
	}

	/**
	 * Updates the loading or generation message shown below the results.
	 *
	 * @param message Status text to display.
	 * @returns Nothing. The page status element is updated in place.
	 */
	static setStatus(message: string): void {
		UiHelper.getElement<HTMLElement>('#status').textContent = message;
	}
}
