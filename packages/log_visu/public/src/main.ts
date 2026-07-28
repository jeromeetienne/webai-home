import { LogEntryParser } from "./log_entry_parser.js";
import { TimelineModel } from "./timeline_model.js";
import { TimelineView } from "./timeline_view.js";
import { PlaybackController } from "./playback_controller.js";
import { EventLogPanel } from "./event_log_panel.js";
import type { CategoryFilters, LogSource, SessionPayload, TimeRangeMs, TimelineEvent } from "./types.js";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Constants
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const SESSION_API_PATH = "/api/session.json";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LogVisuApp — wires the session loader, range/filter controls, diagram, and playback
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Top-level controller for the log flow visualizer page. On startup it tries to fetch
 * a session already prepared by the `log-visu` CLI (every log file merged, the time
 * range and filters chosen on the command line, and autoplay if requested) so viewing
 * a capture needs no clicking at all; dropping a `.jsonl` file onto the page remains
 * available as a manual fallback for ad hoc use.
 */
class LogVisuApp {
	private readonly dropZoneEl: HTMLElement;
	private readonly fileInputEl: HTMLInputElement;
	private readonly statsReadoutEl: HTMLElement;
	private readonly rangeBarEl: HTMLElement;
	private readonly rangeFromEl: HTMLInputElement;
	private readonly rangeToEl: HTMLInputElement;
	private readonly showChatterEl: HTMLInputElement;
	private readonly showSignalingEl: HTMLInputElement;
	private readonly vizMainEl: HTMLElement;
	private readonly playbackBarEl: HTMLElement;
	private readonly playPauseButtonEl: HTMLButtonElement;
	private readonly speedSelectEl: HTMLSelectElement;
	private readonly scrubberEl: HTMLInputElement;
	private readonly timeReadoutEl: HTMLElement;

	private readonly view: TimelineView;
	private readonly eventLogPanel: EventLogPanel;
	private readonly controller: PlaybackController;

	private sources: LogSource[];
	private fullRangeMs: TimeRangeMs | undefined;
	private isScrubbing: boolean;

	constructor() {
		this.dropZoneEl = LogVisuApp._getElement("#drop-zone");
		this.fileInputEl = LogVisuApp._getElement<HTMLInputElement>("#log-file-input");
		this.statsReadoutEl = LogVisuApp._getElement("#stats-readout");
		this.rangeBarEl = LogVisuApp._getElement("#range-bar");
		this.rangeFromEl = LogVisuApp._getElement<HTMLInputElement>("#range-from");
		this.rangeToEl = LogVisuApp._getElement<HTMLInputElement>("#range-to");
		this.showChatterEl = LogVisuApp._getElement<HTMLInputElement>("#show-chatter");
		this.showSignalingEl = LogVisuApp._getElement<HTMLInputElement>("#show-signaling");
		this.vizMainEl = LogVisuApp._getElement("#viz-main");
		this.playbackBarEl = LogVisuApp._getElement("#playback-bar");
		this.playPauseButtonEl = LogVisuApp._getElement<HTMLButtonElement>("#play-pause-button");
		this.speedSelectEl = LogVisuApp._getElement<HTMLSelectElement>("#speed-select");
		this.scrubberEl = LogVisuApp._getElement<HTMLInputElement>("#scrubber");
		this.timeReadoutEl = LogVisuApp._getElement("#time-readout");

		this.view = new TimelineView(LogVisuApp._getElement<SVGSVGElement>("#timeline-svg"));
		this.eventLogPanel = new EventLogPanel(LogVisuApp._getElement("#event-log-list"), (timeMs: number): void => this.controller.seekTo(timeMs));
		this.controller = new PlaybackController({
			onEvent: (event: TimelineEvent): void => {
				this.view.spawnPacket(event);
				this.eventLogPanel.appendEvent(event);
			},
			onSeek: (eventsUpToNow: TimelineEvent[]): void => this.eventLogPanel.showEventsUpTo(eventsUpToNow),
			onTimeUpdate: (currentTimeMs: number): void => this._onTimeUpdate(currentTimeMs),
			onPlayStateChange: (isPlaying: boolean): void => {
				this.playPauseButtonEl.textContent = isPlaying ? "Pause" : "Play";
			},
			onFinish: (): void => {
				this.playPauseButtonEl.textContent = "Play";
			},
		});

		this.sources = [];
		this.fullRangeMs = undefined;
		this.isScrubbing = false;
	}

	/** Wires up every DOM event listener and attempts to load a CLI-prepared session. Call once after construction. */
	start(): void {
		this.fileInputEl.addEventListener("change", (): void => {
			const file: File | undefined = this.fileInputEl.files?.[0];
			if (file !== undefined) void this._handleDroppedFile(file);
		});

		this.dropZoneEl.addEventListener("dragover", (domEvent: DragEvent): void => {
			domEvent.preventDefault();
			this.dropZoneEl.classList.add("drag-over");
		});
		this.dropZoneEl.addEventListener("dragleave", (): void => this.dropZoneEl.classList.remove("drag-over"));
		this.dropZoneEl.addEventListener("drop", (domEvent: DragEvent): void => {
			domEvent.preventDefault();
			this.dropZoneEl.classList.remove("drag-over");
			const file: File | undefined = domEvent.dataTransfer?.files?.[0];
			if (file !== undefined) void this._handleDroppedFile(file);
		});

		this.rangeFromEl.addEventListener("change", (): void => this._rebuildModel());
		this.rangeToEl.addEventListener("change", (): void => this._rebuildModel());
		this.showChatterEl.addEventListener("change", (): void => this._rebuildModel());
		this.showSignalingEl.addEventListener("change", (): void => this._rebuildModel());

		this.playPauseButtonEl.addEventListener("click", (): void => this.controller.togglePlay());
		this.speedSelectEl.addEventListener("change", (): void => this.controller.setSpeed(Number(this.speedSelectEl.value)));

		this.scrubberEl.addEventListener("pointerdown", (): void => {
			this.isScrubbing = true;
		});
		this.scrubberEl.addEventListener("input", (): void => this.controller.seekTo(Number(this.scrubberEl.value)));
		this.scrubberEl.addEventListener("pointerup", (): void => {
			this.isScrubbing = false;
		});

		void this._tryLoadFromApi();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Loads the session the `log-visu` CLI prepared, if any. When the CLI started this
	 * page it wrote every merged log source and the initial range/filters/autoplay
	 * choice to `/api/session.json` before opening the browser, so the whole diagram is
	 * ready to watch without picking a file or typing a date by hand.
	 */
	private async _tryLoadFromApi(): Promise<void> {
		let response: Response;
		try {
			response = await fetch(SESSION_API_PATH);
		} catch {
			return;
		}
		if (!response.ok) return;

		const session = (await response.json()) as SessionPayload;
		this.sources = session.sources;
		this.fullRangeMs = TimelineModel.computeFullRangeMs(session.sources);
		if (this.fullRangeMs === undefined) return;

		this.rangeFromEl.min = LogVisuApp._toDatetimeLocalValue(this.fullRangeMs.fromMs);
		this.rangeFromEl.max = LogVisuApp._toDatetimeLocalValue(this.fullRangeMs.toMs);
		this.rangeToEl.min = this.rangeFromEl.min;
		this.rangeToEl.max = this.rangeFromEl.max;
		this.rangeFromEl.value = LogVisuApp._toDatetimeLocalValue(session.initialState.fromMs);
		this.rangeToEl.value = LogVisuApp._toDatetimeLocalValue(session.initialState.toMs);
		this.showChatterEl.checked = session.initialState.showChatter;
		this.showSignalingEl.checked = session.initialState.showSignaling;
		this._selectSpeed(session.initialState.speed);

		this.rangeBarEl.hidden = false;
		this.vizMainEl.hidden = false;
		this.playbackBarEl.hidden = false;

		this._rebuildModel();
		if (session.initialState.autoplay) this.controller.play();
	}

	private async _handleDroppedFile(file: File): Promise<void> {
		const text: string = await file.text();
		const { entries, lineErrors } = LogEntryParser.parseJsonl(text);

		this.sources = [{ id: "dropped-file", label: file.name, entries }];
		this.fullRangeMs = TimelineModel.computeFullRangeMs(this.sources);

		if (this.fullRangeMs === undefined) {
			this.statsReadoutEl.textContent = `${file.name}: no valid log entries found.`;
			return;
		}

		this.rangeFromEl.removeAttribute("min");
		this.rangeFromEl.removeAttribute("max");
		this.rangeToEl.removeAttribute("min");
		this.rangeToEl.removeAttribute("max");
		this.rangeFromEl.value = LogVisuApp._toDatetimeLocalValue(this.fullRangeMs.fromMs);
		this.rangeToEl.value = LogVisuApp._toDatetimeLocalValue(this.fullRangeMs.toMs);

		this.rangeBarEl.hidden = false;
		this.vizMainEl.hidden = false;
		this.playbackBarEl.hidden = false;

		const errorSuffix: string = lineErrors.length > 0 ? ` (${lineErrors.length} line(s) skipped)` : "";
		this.statsReadoutEl.textContent = `${file.name}: ${entries.length} messages loaded${errorSuffix}`;

		this._rebuildModel();
	}

	private _rebuildModel(): void {
		if (this.fullRangeMs === undefined) return;

		const rangeMs: TimeRangeMs = {
			fromMs: LogVisuApp._fromDatetimeLocalValue(this.rangeFromEl.value) ?? this.fullRangeMs.fromMs,
			toMs: LogVisuApp._fromDatetimeLocalValue(this.rangeToEl.value) ?? this.fullRangeMs.toMs,
		};
		const filters: CategoryFilters = {
			showChatter: this.showChatterEl.checked,
			showSignaling: this.showSignalingEl.checked,
		};

		const { actors, events } = TimelineModel.build(this.sources, rangeMs, filters);

		this.view.render(actors, events);
		this.eventLogPanel.clear();
		this.scrubberEl.min = String(rangeMs.fromMs);
		this.scrubberEl.max = String(rangeMs.toMs);
		this.controller.setTimeline(events, rangeMs);

		const taskCount: number = new Set(events.map((event: TimelineEvent): string | undefined => event.taskId).filter((taskId): taskId is string => taskId !== undefined)).size;
		const gatewayCount: number = actors.filter((actor): boolean => actor.column === "center").length;
		const workerCount: number = actors.filter((actor): boolean => actor.column === "right").length;
		this.statsReadoutEl.textContent = `${events.length} messages in range · ${taskCount} task(s) · ${gatewayCount} gateway run(s) · ${workerCount} worker(s)`;
	}

	private _onTimeUpdate(currentTimeMs: number): void {
		if (!this.isScrubbing) this.scrubberEl.value = String(currentTimeMs);
		this.timeReadoutEl.textContent = new Date(currentTimeMs).toLocaleTimeString(undefined, { hour12: false });
	}

	private _selectSpeed(speed: number): void {
		const hasMatchingOption: boolean = Array.from(this.speedSelectEl.options).some((option: HTMLOptionElement): boolean => Number(option.value) === speed);
		if (!hasMatchingOption) {
			const optionEl: HTMLOptionElement = document.createElement("option");
			optionEl.value = String(speed);
			optionEl.textContent = `${speed}×`;
			this.speedSelectEl.appendChild(optionEl);
		}
		this.speedSelectEl.value = String(speed);
		this.controller.setSpeed(speed);
	}

	private static _getElement<T extends Element = HTMLElement>(selector: string): T {
		const element: Element | null = document.querySelector(selector);
		if (element === null) throw new Error(`Element ${selector} was not found`);
		return element as T;
	}

	private static _toDatetimeLocalValue(epochMs: number): string {
		const date: Date = new Date(epochMs);
		const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
		return (
			`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
			`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
		);
	}

	private static _fromDatetimeLocalValue(value: string): number | undefined {
		if (value.length === 0) return undefined;
		const parsedMs: number = new Date(value).getTime();
		return Number.isNaN(parsedMs) ? undefined : parsedMs;
	}
}

new LogVisuApp().start();
