import { TimelineModel } from './timeline_model.js';
import type { TimelineEvent } from './types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Constants
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const MAX_ROWS = 500;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	EventLogPanel — the scrolling, clickable text list next to the diagram
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Renders the same events the diagram animates as a plain, readable, scrolling list,
 * so the visualization stays legible without the animation and a viewer can click any
 * row to jump playback straight to that moment.
 */
export class EventLogPanel {
	private readonly containerEl: HTMLElement;
	private readonly onSeekRequested: (event: TimelineEvent) => void;

	/**
	 * @param containerEl The element the event list is drawn into.
	 * @param onSeekRequested What to call when the reader clicks one event.
	 */
	constructor(containerEl: HTMLElement, onSeekRequested: (event: TimelineEvent) => void) {
		this.containerEl = containerEl;
		this.onSeekRequested = onSeekRequested;
	}

	/** Removes every event currently listed. */
	clear(): void {
		this.containerEl.replaceChildren();
	}

	/**
	 * Replaces the whole list with every event reached so far, called on every new event during
	 * playback as well as on an explicit seek. Only jumps the view back to the top when it was
	 * already there (following live); if the reader has scrolled down into older events, their
	 * scroll position is preserved instead of being pulled out from under them on each new event.
	 */
	showEventsUpTo(events: TimelineEvent[]): void {
		const wasNearTop: boolean = this.containerEl.scrollTop < 24;
		const heightBefore: number = this.containerEl.scrollHeight;
		const rows: HTMLElement[] = events.slice(-MAX_ROWS).reverse().map((event: TimelineEvent): HTMLElement => this._buildRow(event));
		this.containerEl.replaceChildren(...rows);
		if (wasNearTop) {
			this.containerEl.scrollTop = 0;
		} else {
			this.containerEl.scrollTop += this.containerEl.scrollHeight - heightBefore;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	private _buildRow(event: TimelineEvent): HTMLElement {
		const rowEl: HTMLDivElement = document.createElement('div');
		rowEl.className = 'event-log-row';
		rowEl.style.borderLeftColor = TimelineModel.colorForTaskId(event.taskId);
		rowEl.addEventListener('click', (): void => this.onSeekRequested(event));

		const timeEl: HTMLSpanElement = document.createElement('span');
		timeEl.className = 'row-time';
		timeEl.textContent = new Date(event.timestampMs).toLocaleTimeString(undefined, { hour12: false }) + `.${String(event.timestampMs % 1000).padStart(3, '0')}`;
		rowEl.appendChild(timeEl);

		const summaryEl: HTMLSpanElement = document.createElement('span');
		summaryEl.className = 'event-log-summary';
		const fromRole: string = event.fromActorId.split(':')[0];
		const toRole: string = event.toActorId.split(':')[0];
		summaryEl.append(
			this._buildRolePill(fromRole),
			document.createTextNode(' → '),
			this._buildRolePill(toRole),
			document.createTextNode(`: ${event.summary}`),
		);
		// An answer names the request it answers, taken from the identifiers the log records.
		// A message with nothing here was pushed by the gateway on its own initiative.
		if (event.answersMessageType !== undefined) {
			const answersEl: HTMLSpanElement = document.createElement('span');
			answersEl.className = 'event-log-answers';
			answersEl.textContent = ` (answers ${event.answersMessageType})`;
			summaryEl.appendChild(answersEl);
		}
		rowEl.appendChild(summaryEl);

		return rowEl;
	}

	private _buildRolePill(role: string): HTMLSpanElement {
		const rolePill: HTMLSpanElement = document.createElement('span');
		const bootstrapColor: string = role === 'consumer' ? 'primary' : role === 'gateway' ? 'info' : role === 'worker' ? 'success' : 'secondary';
		rolePill.className = `badge rounded-pill text-bg-${bootstrapColor} role-pill`;
		rolePill.textContent = role;
		return rolePill;
	}
}
