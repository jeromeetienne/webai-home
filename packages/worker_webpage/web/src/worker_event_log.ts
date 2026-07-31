import { PageElements } from './page_elements';
import { PageMarkup } from './page_markup';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerEventLog — the recent events list on the worker browser page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One line in the worker browser's recent events list. */
export type WorkerEvent = {
	direction: 'sent' | 'received' | 'local';
	type: string;
	timestamp: string;
	taskId?: string;
	stage?: string;
	message?: string;
};

/** How many recent events the page keeps on screen. */
const maximumDisplayedEvents = 10;

/**
 * Keeps the most recent events on the worker browser page.
 *
 * The list is bounded, so a browser left running for a long time does not grow its own page
 * without limit. The newest event is shown first.
 */
export class WorkerEventLog {
	private readonly events: WorkerEvent[] = [];

	/** Draws the list as it currently stands, which for a new log is the empty message. */
	render(): void {
		const output: HTMLElement = PageElements.getElement('#events');
		output.innerHTML = this.events.length === 0
			? '<p class="text-secondary mb-0">No events yet.</p>'
			: this.events.slice(-maximumDisplayedEvents).reverse().map((event) => {
				const details = [
					event.taskId === undefined || event.taskId === '' ? '' : `Task ${event.taskId}`,
					event.stage ?? '',
					event.message ?? '',
				]
					.filter((part) => part !== '')
					.map((part) => PageMarkup.escapeHtml(part))
					.join(' · ');
				return `<article class="event-item"><div class="d-flex justify-content-between gap-3"><strong>${PageMarkup.escapeHtml(event.type)}</strong><time class="text-secondary">${PageMarkup.escapeHtml(PageMarkup.formatTime(event.timestamp))}</time></div><div class="small text-secondary">${PageMarkup.escapeHtml(event.direction)}${details === '' ? '' : ` · ${details}`}</div></article>`;
			}).join('');
	}

	/**
	 * Adds one event and draws the list again.
	 *
	 * @param event The event to add.
	 */
	add(event: WorkerEvent): void {
		this.events.push(event);
		if (this.events.length > maximumDisplayedEvents) this.events.splice(0, this.events.length - maximumDisplayedEvents);
		this.render();
	}
}
