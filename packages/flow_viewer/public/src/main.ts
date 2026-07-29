import { LogEntryParser } from "./log_entry_parser.js";
import { TimelineModel } from "./timeline_model.js";
import { TimelineView } from "./timeline_view.js";
import { PlaybackController } from "./playback_controller.js";
import type { PlaybackSegment } from "./playback_controller.js";
import { EventLogPanel } from "./event_log_panel.js";
import type { CategoryFilters, LogSource, SessionPayload, TimeRangeMs, TimelineEvent } from "./types.js";
import { calculateStatistics, formatBytes, formatLatency, type StatisticsReport, type StatisticsTotals } from "./statistics.js";
import SAMPLE_LOG_TEXT from "../../fixtures/sample-gateway-log.jsonl?raw";
import { setupThemeToggle } from "../../../shared/theme.js";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Constants
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const SESSION_API_PATH = "/api/session.json";
const SPEED_STORAGE_KEY = "webai-flow-viewer-speed";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	FlowViewerApp — wires the session loader, range/filter controls, diagram, and playback
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Top-level controller for the flow_viewer page. On startup it tries to fetch
 * a session already prepared by the `flow_viewer` CLI (every log file merged and the time
 * range and filters chosen on the command line) so viewing a capture is ready immediately;
 * playback remains paused until the user starts it. Dropping a `.jsonl` file onto the page
 * remains available as a manual fallback for ad hoc use.
 */
class FlowViewerApp {
	private readonly dropZoneEl: HTMLElement;
	private readonly fileInputEl: HTMLInputElement;
	private readonly statsReadoutEl: HTMLElement;
	private readonly rangeBarEl: HTMLElement;
	private readonly rangeFromEl: HTMLInputElement;
	private readonly rangeToEl: HTMLInputElement;
	private readonly statisticsPanelEl: HTMLElement;
	private readonly statisticsCardsEl: HTMLElement;
	private readonly statisticsNoteEl: HTMLElement;
	private readonly statisticsTableBodyEl: HTMLElement;
	private readonly showChatterEl: HTMLInputElement;
	private readonly showSignalingEl: HTMLInputElement;
	private readonly vizMainEl: HTMLElement;
	private readonly playbackBarEl: HTMLElement;
	private readonly keyboardHelpTriggerEl: HTMLButtonElement;
	private readonly keyboardHelpModalEl: HTMLElement;
	private readonly eventDetailsModalEl: HTMLElement;
	private readonly eventDetailsBodyEl: HTMLElement;
	private readonly copyEventButtonEl: HTMLButtonElement;
	private readonly playPauseButtonEl: HTMLButtonElement;
	private readonly stopButtonEl: HTMLButtonElement;
	private readonly speedSelectEl: HTMLSelectElement;
	private readonly packetDurationSelectEl: HTMLSelectElement;
	private readonly loopPlaybackEl: HTMLInputElement;
	private readonly scrubberEl: HTMLInputElement;
	private readonly timeReadoutEl: HTMLElement;

	private readonly view: TimelineView;
	private readonly eventLogPanel: EventLogPanel;
	private readonly controller: PlaybackController;

	private sources: LogSource[];
	private fullRangeMs: TimeRangeMs | undefined;
	private isScrubbing: boolean;

	constructor() {
		this.dropZoneEl = FlowViewerApp._getElement("#drop-zone");
		this.fileInputEl = FlowViewerApp._getElement<HTMLInputElement>("#log-file-input");
		this.statsReadoutEl = FlowViewerApp._getElement("#stats-readout");
		this.rangeBarEl = FlowViewerApp._getElement("#range-bar");
		this.rangeFromEl = FlowViewerApp._getElement<HTMLInputElement>("#range-from");
		this.rangeToEl = FlowViewerApp._getElement<HTMLInputElement>("#range-to");
		this.statisticsPanelEl = FlowViewerApp._getElement("#statistics-panel");
		this.statisticsCardsEl = FlowViewerApp._getElement("#statistics-cards");
		this.statisticsNoteEl = FlowViewerApp._getElement("#statistics-note");
		this.statisticsTableBodyEl = FlowViewerApp._getElement("#statistics-table-body");
		this.showChatterEl = FlowViewerApp._getElement<HTMLInputElement>("#show-chatter");
		this.showSignalingEl = FlowViewerApp._getElement<HTMLInputElement>("#show-signaling");
		this.vizMainEl = FlowViewerApp._getElement("#viz-main");
		this.playbackBarEl = FlowViewerApp._getElement("#playback-bar");
		this.keyboardHelpTriggerEl = FlowViewerApp._getElement<HTMLButtonElement>("#keyboard-help-trigger");
		this.keyboardHelpModalEl = FlowViewerApp._getElement("#keyboard-help-modal");
		this.eventDetailsModalEl = FlowViewerApp._getElement("#event-details-modal");
		this.eventDetailsBodyEl = FlowViewerApp._getElement("#event-details-body");
		this.copyEventButtonEl = FlowViewerApp._getElement<HTMLButtonElement>("#copy-event-button");
		this.playPauseButtonEl = FlowViewerApp._getElement<HTMLButtonElement>("#play-pause-button");
		this.stopButtonEl = FlowViewerApp._getElement<HTMLButtonElement>("#stop-button");
		this.speedSelectEl = FlowViewerApp._getElement<HTMLSelectElement>("#speed-select");
		this.packetDurationSelectEl = FlowViewerApp._getElement<HTMLSelectElement>("#packet-duration-select");
		this.loopPlaybackEl = FlowViewerApp._getElement<HTMLInputElement>("#loop-playback");
		this.scrubberEl = FlowViewerApp._getElement<HTMLInputElement>("#scrubber");
		this.timeReadoutEl = FlowViewerApp._getElement("#time-readout");

		this.view = new TimelineView(FlowViewerApp._getElement<SVGSVGElement>("#timeline-svg"), (event: TimelineEvent): void => this._showEventDetails(event));
		this.eventLogPanel = new EventLogPanel(FlowViewerApp._getElement("#event-log-list"), (event: TimelineEvent): void => this.controller.seekToEvent(event));
		this.controller = new PlaybackController({
			onSeek: (eventsUpToNow: TimelineEvent[]): void => this.eventLogPanel.showEventsUpTo(eventsUpToNow),
			onTimeUpdate: (visualTimeMs: number, logTimeMs: number, activeSegment: PlaybackSegment | undefined, packetProgress: number): void => {
				this.view.setPlaybackFrame(activeSegment?.event, packetProgress);
				this._onTimeUpdate(visualTimeMs, logTimeMs);
			},
			onPlayStateChange: (isPlaying: boolean): void => {
				this._updatePlayPauseButton(isPlaying);
			},
			onFinish: (): void => {
				this._updatePlayPauseButton(false);
			},
		});

		this.sources = [];
		this.fullRangeMs = undefined;
		this.isScrubbing = false;
	}

	/** Wires up every DOM event listener and attempts to load a CLI-prepared session. Call once after construction. */
	start(): void {
		setupThemeToggle();
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
		this.stopButtonEl.addEventListener("click", (): void => this.controller.stop());
		this.speedSelectEl.addEventListener("change", (): void => {
			const speed: number = Number(this.speedSelectEl.value);
			this.controller.setSpeed(speed);
			this._saveSpeed(speed);
		});
		this.packetDurationSelectEl.addEventListener("change", (): void => {
			this.controller.setPacketDuration(Number(this.packetDurationSelectEl.value));
			this._updateScrubberRange();
		});
		this.loopPlaybackEl.addEventListener("change", (): void => this.controller.setLoop(this.loopPlaybackEl.checked));
		this.copyEventButtonEl.addEventListener("click", (): void => void this._copyEventDetails());
		document.addEventListener("keydown", (event: KeyboardEvent): void => {
			if (FlowViewerApp._isFormControl(event.target)) return;
			if (event.key === "?") {
				event.preventDefault();
				if (this.keyboardHelpModalEl.classList.contains("show")) {
					this.keyboardHelpModalEl.querySelector<HTMLButtonElement>("[data-bs-dismiss='modal']")?.click();
				} else {
					this.keyboardHelpTriggerEl.click();
				}
				return;
			}
			const speedKeyIndex: number = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7"].indexOf(event.code);
			if (speedKeyIndex !== -1) {
				event.preventDefault();
				this._selectSpeedOption(speedKeyIndex);
				return;
			}
			if (event.code === "ArrowLeft") {
				event.preventDefault();
				this.controller.seekBy(-5000);
				return;
			}
			if (event.code === "ArrowRight") {
				event.preventDefault();
				this.controller.seekBy(5000);
				return;
			}
			if (event.code !== "Space") return;
			event.preventDefault();
			this.controller.togglePlay();
		});

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
	 * Loads the session the `flow_viewer` CLI prepared, if any. When the CLI started this
	 * page it wrote every merged log source and the initial range and filter choices to
	 * `/api/session.json` before opening the browser, so the whole diagram is ready to
	 * watch without picking a file or typing a date by hand. Playback starts paused.
	 */
	private async _tryLoadFromApi(): Promise<void> {
		let response: Response;
		try {
			response = await fetch(SESSION_API_PATH);
		} catch {
			this._loadBundledSampleLog();
			return;
		}
		if (!response.ok) {
			this._loadBundledSampleLog();
			return;
		}

		let session: SessionPayload;
		try {
			session = (await response.json()) as SessionPayload;
		} catch {
			this._loadBundledSampleLog();
			return;
		}
		this.sources = session.sources;
		this.fullRangeMs = TimelineModel.computeFullRangeMs(session.sources);
		if (this.fullRangeMs === undefined) return;

		this.rangeFromEl.min = FlowViewerApp._toDatetimeLocalValue(this.fullRangeMs.fromMs);
		this.rangeFromEl.max = FlowViewerApp._toDatetimeLocalValue(this.fullRangeMs.toMs);
		this.rangeToEl.min = this.rangeFromEl.min;
		this.rangeToEl.max = this.rangeFromEl.max;
		this.rangeFromEl.value = FlowViewerApp._toDatetimeLocalValue(session.initialState.fromMs);
		this.rangeToEl.value = FlowViewerApp._toDatetimeLocalValue(session.initialState.toMs);
		this.showChatterEl.checked = session.initialState.showChatter;
		this.showSignalingEl.checked = session.initialState.showSignaling;
		this._selectSpeed(this._getInitialSpeed(session.initialState.speed));

		this.rangeBarEl.hidden = false;
		this.vizMainEl.hidden = false;
		this.playbackBarEl.hidden = false;

		this._rebuildModel();
	}

	/** Loads the bundled example when the page is opened directly without a CLI session. */
	private _loadBundledSampleLog(): void {
		const { entries, lineErrors } = LogEntryParser.parseJsonl(SAMPLE_LOG_TEXT);
		this.sources = [{ id: "bundled-sample", label: "Sample gateway log", entries }];
		this.fullRangeMs = TimelineModel.computeFullRangeMs(this.sources);
		if (this.fullRangeMs === undefined) return;

		this.rangeFromEl.value = FlowViewerApp._toDatetimeLocalValue(this.fullRangeMs.fromMs);
		this.rangeToEl.value = FlowViewerApp._toDatetimeLocalValue(this.fullRangeMs.toMs);
		this._selectSpeed(this._getInitialSpeed(1));
		this.rangeBarEl.hidden = false;
		this.vizMainEl.hidden = false;
		this.playbackBarEl.hidden = false;
		this.statsReadoutEl.textContent = `Sample gateway log: ${entries.length} messages loaded${lineErrors.length > 0 ? ` (${lineErrors.length} line(s) skipped)` : ""}`;
		this._rebuildModel();
	}

	private _updatePlayPauseButton(isPlaying: boolean): void {
		const iconEl: HTMLElement | null = this.playPauseButtonEl.querySelector("i");
		if (iconEl !== null) iconEl.className = isPlaying ? "bi bi-pause-fill" : "bi bi-play-fill";
		const label: string = isPlaying ? "Pause" : "Play";
		this.playPauseButtonEl.setAttribute("aria-label", label);
		this.playPauseButtonEl.title = label;
	}

	private _showEventDetails(event: TimelineEvent): void {
		this.eventDetailsBodyEl.textContent = JSON.stringify(event.logEntry, null, 2);
		this.copyEventButtonEl.textContent = "Copy";
		const bootstrap = (window as Window & { bootstrap?: { Modal: { getOrCreateInstance(element: Element): { show(): void } } } }).bootstrap;
		bootstrap?.Modal.getOrCreateInstance(this.eventDetailsModalEl).show();
	}

	private async _copyEventDetails(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.eventDetailsBodyEl.textContent ?? "");
			this.copyEventButtonEl.textContent = "Copied";
			window.setTimeout((): void => { this.copyEventButtonEl.textContent = "Copy"; }, 1500);
		} catch {
			this.copyEventButtonEl.textContent = "Copy failed";
		}
	}

	private _getInitialSpeed(fallbackSpeed: number): number {
		try {
			const storedSpeed: number = Number(window.localStorage.getItem(SPEED_STORAGE_KEY));
			return Number.isFinite(storedSpeed) && storedSpeed > 0 ? storedSpeed : fallbackSpeed;
		} catch {
			return fallbackSpeed;
		}
	}

	private _saveSpeed(speed: number): void {
		try {
			window.localStorage.setItem(SPEED_STORAGE_KEY, String(speed));
		} catch {
			// Storage can be unavailable in private browsing or restricted embeds.
		}
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
		this.rangeFromEl.value = FlowViewerApp._toDatetimeLocalValue(this.fullRangeMs.fromMs);
		this.rangeToEl.value = FlowViewerApp._toDatetimeLocalValue(this.fullRangeMs.toMs);

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
			fromMs: FlowViewerApp._fromDatetimeLocalValue(this.rangeFromEl.value) ?? this.fullRangeMs.fromMs,
			toMs: FlowViewerApp._fromDatetimeLocalValue(this.rangeToEl.value) ?? this.fullRangeMs.toMs,
		};
		const filters: CategoryFilters = {
			showChatter: this.showChatterEl.checked,
			showSignaling: this.showSignalingEl.checked,
		};

		const { actors, events } = TimelineModel.build(this.sources, rangeMs, filters);

		this.view.render(actors, events);
		this._renderStatistics(calculateStatistics(this.sources, events, rangeMs));
		this.eventLogPanel.clear();
		this.controller.setTimeline(events, rangeMs);
		this._updateScrubberRange();

		const taskCount: number = new Set(events.map((event: TimelineEvent): string | undefined => event.taskId).filter((taskId): taskId is string => taskId !== undefined)).size;
		const gatewayCount: number = actors.filter((actor): boolean => actor.column === "center").length;
		const workerCount: number = actors.filter((actor): boolean => actor.column === "right").length;
		this.statsReadoutEl.textContent = `${events.length} messages in range · ${taskCount} task(s) · ${gatewayCount} gateway run(s) · ${workerCount} worker(s)`;
	}

	private _renderStatistics(report: StatisticsReport): void {
		const total = report.total;
		this.statisticsNoteEl.textContent = `${total.measuredMessages} measured · ${total.estimatedMessages} estimated (older log entries)`;
		const cards: Array<[string, string]> = [
			["Messages", String(total.messageCount)], ["Total bandwidth", formatBytes(total.messageBytes)],
			["Payload", formatBytes(total.payloadBytes)], ["Duplicate data", formatBytes(total.duplicateBytes)],
			["Average latency", formatLatency(total)],
		];
		this.statisticsCardsEl.replaceChildren(...cards.map(([label, value]) => {
			const card = document.createElement("div"); card.className = "statistics-card";
			card.innerHTML = `<span class="statistics-card-label">${label}</span><span class="statistics-card-value">${value}</span>`;
			return card;
		}));
		this.statisticsTableBodyEl.replaceChildren();
		this._appendStatisticsRows("Task", report.byTask);
		this._appendStatisticsRows("Route", report.byRoute);
		this._appendStatisticsRows("Worker", report.byWorker);
		this._appendStatisticsRows("Stage", report.byStage);
		this._appendStatisticsRows("Message type", report.byMessageType);
	}

	private _appendStatisticsRows(group: string, values: Map<string, StatisticsTotals>): void {
		for (const [name, totals] of values) {
			const row = document.createElement("tr");
			const overhead = Math.max(0, totals.messageBytes - totals.payloadBytes);
			row.innerHTML = `<td>${group}: ${name}</td><td>${totals.messageCount}</td><td>${formatBytes(totals.payloadBytes)}</td><td>${formatBytes(totals.messageBytes)}</td><td>${formatBytes(totals.duplicateBytes)}</td><td>${formatBytes(totals.usefulBytes)} / ${formatBytes(overhead)}</td><td>${formatLatency(totals)}</td>`;
			this.statisticsTableBodyEl.appendChild(row);
		}
	}

	private _onTimeUpdate(visualTimeMs: number, logTimeMs: number): void {
		if (!this.isScrubbing) this.scrubberEl.value = String(visualTimeMs);
		this._updateScrubberProgress();
		this.timeReadoutEl.textContent = new Date(logTimeMs).toLocaleTimeString(undefined, { hour12: false });
	}

	private _updateScrubberRange(): void {
		this.scrubberEl.min = "0";
		this.scrubberEl.max = String(this.controller.getVisualDuration());
		if (Number(this.scrubberEl.value) > this.controller.getVisualDuration()) this.scrubberEl.value = String(this.controller.getVisualDuration());
		this._updateScrubberProgress();
	}

	private _updateScrubberProgress(): void {
		const min: number = Number(this.scrubberEl.min);
		const max: number = Number(this.scrubberEl.max);
		const value: number = Number(this.scrubberEl.value);
		const progress: number = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
		this.scrubberEl.style.setProperty("--range-progress", `${progress}%`);
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

	private _selectSpeedOption(index: number): void {
		const option: HTMLOptionElement | undefined = this.speedSelectEl.options[index];
		if (option === undefined) return;
		this.speedSelectEl.value = option.value;
		const speed: number = Number(option.value);
		this.controller.setSpeed(speed);
		this._saveSpeed(speed);
	}

	private static _getElement<T extends Element = HTMLElement>(selector: string): T {
		const element: Element | null = document.querySelector(selector);
		if (element === null) throw new Error(`Element ${selector} was not found`);
		return element as T;
	}

	private static _isFormControl(target: EventTarget | null): boolean {
		return target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName);
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

new FlowViewerApp().start();
