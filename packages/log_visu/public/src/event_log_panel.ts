import { TimelineModel } from "./timeline_model.js";
import type { TimelineEvent } from "./types.js";

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
	private readonly onSeekRequested: (timeMs: number) => void;

	constructor(containerEl: HTMLElement, onSeekRequested: (timeMs: number) => void) {
		this.containerEl = containerEl;
		this.onSeekRequested = onSeekRequested;
	}

	clear(): void {
		this.containerEl.replaceChildren();
	}

	/** Appends one row for a newly-reached event and scrolls it into view. */
	appendEvent(event: TimelineEvent): void {
		this.containerEl.appendChild(this._buildRow(event));
		while (this.containerEl.childElementCount > MAX_ROWS) this.containerEl.firstElementChild?.remove();
		this.containerEl.scrollTop = this.containerEl.scrollHeight;
	}

	/** Replaces the whole list with every event up to a seek target, without per-row scrolling. */
	showEventsUpTo(events: TimelineEvent[]): void {
		const rows: HTMLElement[] = events.slice(-MAX_ROWS).map((event: TimelineEvent): HTMLElement => this._buildRow(event));
		this.containerEl.replaceChildren(...rows);
		this.containerEl.scrollTop = this.containerEl.scrollHeight;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	private _buildRow(event: TimelineEvent): HTMLElement {
		const rowEl: HTMLDivElement = document.createElement("div");
		rowEl.className = "event-log-row";
		rowEl.style.borderLeftColor = TimelineModel.colorForTaskId(event.taskId);
		rowEl.addEventListener("click", (): void => this.onSeekRequested(event.timestampMs));

		const timeEl: HTMLSpanElement = document.createElement("span");
		timeEl.className = "row-time";
		timeEl.textContent = new Date(event.timestampMs).toLocaleTimeString(undefined, { hour12: false }) + `.${String(event.timestampMs % 1000).padStart(3, "0")}`;
		rowEl.appendChild(timeEl);

		const summaryEl: HTMLSpanElement = document.createElement("span");
		summaryEl.textContent = `${event.fromActorId.split(":")[0]} → ${event.toActorId.split(":")[0]}: ${event.summary}`;
		rowEl.appendChild(summaryEl);

		return rowEl;
	}
}
