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
	private readonly onSeekRequested: (event: TimelineEvent) => void;

	constructor(containerEl: HTMLElement, onSeekRequested: (event: TimelineEvent) => void) {
		this.containerEl = containerEl;
		this.onSeekRequested = onSeekRequested;
	}

	clear(): void {
		this.containerEl.replaceChildren();
	}

	/** Adds one row for a newly-reached event at the top of the list. */
	appendEvent(event: TimelineEvent): void {
		this.containerEl.prepend(this._buildRow(event));
		while (this.containerEl.childElementCount > MAX_ROWS) this.containerEl.lastElementChild?.remove();
		this.containerEl.scrollTop = 0;
	}

	/** Replaces the whole list with every event up to a seek target, without per-row scrolling. */
	showEventsUpTo(events: TimelineEvent[]): void {
		const rows: HTMLElement[] = events.slice(-MAX_ROWS).reverse().map((event: TimelineEvent): HTMLElement => this._buildRow(event));
		this.containerEl.replaceChildren(...rows);
		this.containerEl.scrollTop = 0;
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
		rowEl.addEventListener("click", (): void => this.onSeekRequested(event));

		const timeEl: HTMLSpanElement = document.createElement("span");
		timeEl.className = "row-time";
		timeEl.textContent = new Date(event.timestampMs).toLocaleTimeString(undefined, { hour12: false }) + `.${String(event.timestampMs % 1000).padStart(3, "0")}`;
		rowEl.appendChild(timeEl);

		const summaryEl: HTMLSpanElement = document.createElement("span");
		summaryEl.className = "event-log-summary";
		const fromRole: string = event.fromActorId.split(":")[0];
		const toRole: string = event.toActorId.split(":")[0];
		summaryEl.append(
			this._buildRolePill(fromRole),
			document.createTextNode(" → "),
			this._buildRolePill(toRole),
			document.createTextNode(`: ${event.summary}`),
		);
		// An answer names the request it answers, taken from the identifiers the log records.
		// A message with nothing here was pushed by the gateway on its own initiative.
		if (event.answersMessageType !== undefined) {
			const answersEl: HTMLSpanElement = document.createElement("span");
			answersEl.className = "event-log-answers";
			answersEl.textContent = ` (answers ${event.answersMessageType})`;
			summaryEl.appendChild(answersEl);
		}
		rowEl.appendChild(summaryEl);

		return rowEl;
	}

	private _buildRolePill(role: string): HTMLSpanElement {
		const rolePill: HTMLSpanElement = document.createElement("span");
		const bootstrapColor: string = role === "consumer" ? "primary" : role === "gateway" ? "info" : role === "worker" ? "success" : "secondary";
		rolePill.className = `badge rounded-pill text-bg-${bootstrapColor} role-pill`;
		rolePill.textContent = role;
		return rolePill;
	}
}
