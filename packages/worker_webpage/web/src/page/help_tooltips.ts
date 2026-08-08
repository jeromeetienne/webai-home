import { Tooltip } from 'bootstrap';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HelpTooltips — turns every element marked up for a Bootstrap tooltip into one
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Wires up Bootstrap's own tooltip component wherever the page marks an element with
 * `data-bs-toggle="tooltip"`, instead of leaving the browser to show its own plain, unstyled
 * title tooltip.
 */
export class HelpTooltips {
	/**
	 * Finds every element marked up for a tooltip and turns it into a live Bootstrap tooltip.
	 *
	 * @param selector The elements to turn into tooltips.
	 */
	static setup(selector = '[data-bs-toggle="tooltip"]'): void {
		for (const element of document.querySelectorAll(selector)) {
			new Tooltip(element);
		}
	}
}
