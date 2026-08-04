import type { TimeRangeMs, TimelineEvent } from './types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	PlaybackController — advances the viewer through a capture over time
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The stretch of the visual timeline that one event occupies. */
export type PlaybackSegment = {
	event: TimelineEvent;
	startMs: number;
	endMs: number;
};

/** What the controller reports back as playback advances. */
export type PlaybackCallbacks = {
	onSeek: (eventsUpToNow: TimelineEvent[]) => void;
	onTimeUpdate: (visualTimeMs: number, logTimeMs: number, activeSegment: PlaybackSegment | undefined, packetProgress: number) => void;
	onPlayStateChange: (isPlaying: boolean) => void;
	onFinish: () => void;
};

/**
 * Plays the log on a deliberately expanded visual timeline. Real timestamps still
 * determine event order and remain visible in the event list, while short real-time
 * gaps are expanded so every packet has time to be seen travelling between actors.
 */
export class PlaybackController {
	private readonly callbacks: PlaybackCallbacks;
	private events: TimelineEvent[];
	private segments: PlaybackSegment[];
	private timeRangeMs: TimeRangeMs;
	private currentTimeMs: number;
	private speed: number;
	private packetDurationMs: number;
	private isLooping: boolean;
	private isPlaying: boolean;
	private nextEventIndex: number;
	private notifiedEventIndex: number;
	private rafHandle: number | undefined;
	private playStartRealMs: number;
	private playStartVisualMs: number;

	private readonly _tick = (nowRealMs: number): void => {
		const elapsedVisualMs: number = (nowRealMs - this.playStartRealMs) * this.speed;
		const currentVisualMs: number = Math.min(this.playStartVisualMs + elapsedVisualMs, this.timeRangeMs.toMs);
		this._updateAt(currentVisualMs);

		if (currentVisualMs >= this.timeRangeMs.toMs) {
			if (this.isLooping) {
				this.seekTo(this.timeRangeMs.fromMs);
				this.playStartRealMs = performance.now();
				this.playStartVisualMs = this.currentTimeMs;
				this.rafHandle = requestAnimationFrame(this._tick);
				return;
			}
			this.isPlaying = false;
			this.callbacks.onPlayStateChange(false);
			this.callbacks.onFinish();
			return;
		}

		this.rafHandle = requestAnimationFrame(this._tick);
	};

	/**
	 * @param callbacks What to call as playback advances.
	 */
	constructor(callbacks: PlaybackCallbacks) {
		this.callbacks = callbacks;
		this.events = [];
		this.segments = [];
		this.timeRangeMs = { fromMs: 0, toMs: 0 };
		this.currentTimeMs = 0;
		this.speed = 1;
		this.packetDurationMs = 1500;
		this.isLooping = false;
		this.isPlaying = false;
		this.nextEventIndex = 0;
		this.notifiedEventIndex = -1;
		this.playStartRealMs = 0;
		this.playStartVisualMs = 0;
	}

	/**
	 * Loads the events to play, and pauses at the start of them.
	 *
	 * @param events The events to play, in time order.
	 * @param _logTimeRangeMs The real time range the events cover, which the expanded visual
	 * timeline does not use.
	 */
	setTimeline(events: TimelineEvent[], _logTimeRangeMs: TimeRangeMs): void {
		this.pause();
		this.events = events;
		this.segments = this._buildSegments(events);
		this.timeRangeMs = { fromMs: 0, toMs: this.segments.at(-1)?.endMs ?? 0 };
		this.currentTimeMs = this.timeRangeMs.fromMs;
		this.nextEventIndex = 0;
		this.notifiedEventIndex = -1;
		this._updateAt(this.currentTimeMs);
	}

	/**
	 * Changes how long each event takes on the visual timeline, keeping the current position.
	 *
	 * @param durationMs How long one event should take, in milliseconds.
	 */
	setPacketDuration(durationMs: number): void {
		if (Number.isFinite(durationMs) === false || durationMs <= 0 || durationMs === this.packetDurationMs) return;
		const oldRatio: number = this.timeRangeMs.toMs > 0 ? this.currentTimeMs / this.timeRangeMs.toMs : 0;
		this.packetDurationMs = durationMs;
		this.segments = this._buildSegments(this.events);
		this.timeRangeMs = { fromMs: 0, toMs: this.segments.at(-1)?.endMs ?? 0 };
		this._updateAt(Math.min(this.timeRangeMs.toMs, oldRatio * this.timeRangeMs.toMs));
		if (this.isPlaying) {
			this.playStartRealMs = performance.now();
			this.playStartVisualMs = this.currentTimeMs;
		}
	}

	/** Returns how long each event currently takes on the visual timeline. */
	getPacketDuration(): number {
		return this.packetDurationMs;
	}

	/** Returns how long the whole capture takes on the visual timeline. */
	getVisualDuration(): number {
		return this.timeRangeMs.toMs;
	}

	/** Starts playing, from the beginning again when playback had reached the end. */
	play(): void {
		if (this.isPlaying) return;
		if (this.currentTimeMs >= this.timeRangeMs.toMs) this.seekTo(this.timeRangeMs.fromMs);
		this.isPlaying = true;
		this.playStartRealMs = performance.now();
		this.playStartVisualMs = this.currentTimeMs;
		this.callbacks.onPlayStateChange(true);
		this.rafHandle = requestAnimationFrame(this._tick);
	}

	/** Stops playing, leaving the current position where it is. */
	pause(): void {
		if (this.rafHandle !== undefined) cancelAnimationFrame(this.rafHandle);
		this.rafHandle = undefined;
		if (this.isPlaying) this.callbacks.onPlayStateChange(false);
		this.isPlaying = false;
	}

	/** Starts playing when paused, and pauses when playing. */
	togglePlay(): void {
		if (this.isPlaying) this.pause();
		else this.play();
	}

	/** Stops playing and returns to the start. */
	stop(): void {
		this.pause();
		this.seekTo(this.timeRangeMs.fromMs);
	}

	/**
	 * Changes how fast the visual timeline advances.
	 *
	 * @param speed The multiple of normal speed to play at.
	 */
	setSpeed(speed: number): void {
		this.speed = speed;
		if (this.isPlaying) {
			this.playStartRealMs = performance.now();
			this.playStartVisualMs = this.currentTimeMs;
		}
	}

	/**
	 * Chooses whether playback starts again on reaching the end.
	 *
	 * @param looping Whether to start again.
	 */
	setLoop(looping: boolean): void {
		this.isLooping = looping;
	}

	/**
	 * Moves to one moment on the visual timeline.
	 *
	 * @param visualTimeMs The moment to move to, clamped to the timeline.
	 */
	seekTo(visualTimeMs: number): void {
		this._updateAt(Math.min(Math.max(visualTimeMs, this.timeRangeMs.fromMs), this.timeRangeMs.toMs));
		if (this.isPlaying) {
			this.playStartRealMs = performance.now();
			this.playStartVisualMs = this.currentTimeMs;
		}
	}

	/**
	 * Moves forward or back along the visual timeline.
	 *
	 * @param offsetMs How far to move, negative to move back.
	 */
	seekBy(offsetMs: number): void {
		this.seekTo(this.currentTimeMs + offsetMs);
	}

	/**
	 * Moves to the moment one event begins.
	 *
	 * @param event The event to move to. An event not in the capture is ignored.
	 */
	seekToEvent(event: TimelineEvent): void {
		const segment: PlaybackSegment | undefined = this.segments.find((candidate): boolean => candidate.event === event);
		if (segment !== undefined) this.seekTo(segment.startMs);
	}

	private _updateAt(visualTimeMs: number): void {
		this.currentTimeMs = visualTimeMs;
		this.nextEventIndex = this.segments.findIndex((segment): boolean => segment.startMs > visualTimeMs);
		if (this.nextEventIndex === -1) this.nextEventIndex = this.segments.length;

		const activeSegment: PlaybackSegment | undefined = this.segments.find(
			(segment): boolean => visualTimeMs >= segment.startMs && visualTimeMs < segment.endMs,
		);
		const packetProgress: number = activeSegment === undefined ? 0 : (visualTimeMs - activeSegment.startMs) / (activeSegment.endMs - activeSegment.startMs);
		if (this.nextEventIndex !== this.notifiedEventIndex) {
			this.notifiedEventIndex = this.nextEventIndex;
			this.callbacks.onSeek(this.segments.slice(0, this.nextEventIndex).map((segment): TimelineEvent => segment.event));
		}
		this.callbacks.onTimeUpdate(visualTimeMs, this._logTimeAt(visualTimeMs), activeSegment, packetProgress);
	}

	private _buildSegments(events: TimelineEvent[]): PlaybackSegment[] {
		let cursorMs = 0;
		return events.map((event: TimelineEvent, index: number): PlaybackSegment => {
			const previousEvent: TimelineEvent | undefined = events[index - 1];
			const realGapMs: number = previousEvent === undefined ? 0 : Math.max(0, event.timestampMs - previousEvent.timestampMs);
			const idleBeforeMs: number = Math.max(0, realGapMs - this.packetDurationMs);
			const startMs: number = cursorMs + idleBeforeMs;
			const segment: PlaybackSegment = {
				event,
				startMs,
				endMs: startMs + this.packetDurationMs,
			};
			cursorMs = segment.endMs;
			return segment;
		});
	}

	private _logTimeAt(visualTimeMs: number): number {
		if (this.segments.length === 0) return 0;
		const activeSegment: PlaybackSegment | undefined = this.segments.find(
			(segment): boolean => visualTimeMs >= segment.startMs && visualTimeMs < segment.endMs,
		);
		if (activeSegment !== undefined) return activeSegment.event.timestampMs;
		const nextSegment: PlaybackSegment | undefined = this.segments.find((segment): boolean => segment.startMs > visualTimeMs);
		return nextSegment?.event.timestampMs ?? this.segments.at(-1)!.event.timestampMs;
	}
}
