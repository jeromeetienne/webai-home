import type { TimeRangeMs, TimelineEvent } from "./types.js";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Callbacks the playback clock fires as it advances through the log's real timestamps. */
export interface PlaybackCallbacks {
	onEvent: (event: TimelineEvent) => void;
	onSeek: (eventsUpToNow: TimelineEvent[]) => void;
	onTimeUpdate: (currentTimeMs: number) => void;
	onPlayStateChange: (isPlaying: boolean) => void;
	onFinish: () => void;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	PlaybackController — a virtual clock over the log's real timestamps
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Drives playback through a sorted list of `TimelineEvent`s using the events' own
 * timestamps, scaled by a speed multiplier, rather than replaying them at fixed
 * intervals — a burst of messages a few milliseconds apart in the log still arrives
 * as a burst on screen, and a multi-second gap still reads as a pause.
 */
export class PlaybackController {
	private readonly callbacks: PlaybackCallbacks;
	private events: TimelineEvent[];
	private timeRangeMs: TimeRangeMs;
	private currentTimeMs: number;
	private speed: number;
	private isPlaying: boolean;
	private nextEventIndex: number;
	private rafHandle: number | undefined;
	private playStartRealMs: number;
	private playStartVirtualMs: number;

	private readonly _tick = (nowRealMs: number): void => {
		const elapsedVirtualMs: number = (nowRealMs - this.playStartRealMs) * this.speed;
		const currentVirtualMs: number = Math.min(this.playStartVirtualMs + elapsedVirtualMs, this.timeRangeMs.toMs);

		while (this.nextEventIndex < this.events.length && this.events[this.nextEventIndex]!.timestampMs <= currentVirtualMs) {
			this.callbacks.onEvent(this.events[this.nextEventIndex]!);
			this.nextEventIndex++;
		}

		this.currentTimeMs = currentVirtualMs;
		this.callbacks.onTimeUpdate(this.currentTimeMs);

		if (currentVirtualMs >= this.timeRangeMs.toMs) {
			this.isPlaying = false;
			this.callbacks.onPlayStateChange(false);
			this.callbacks.onFinish();
			return;
		}

		this.rafHandle = requestAnimationFrame(this._tick);
	};

	constructor(callbacks: PlaybackCallbacks) {
		this.callbacks = callbacks;
		this.events = [];
		this.timeRangeMs = { fromMs: 0, toMs: 0 };
		this.currentTimeMs = 0;
		this.speed = 1;
		this.isPlaying = false;
		this.nextEventIndex = 0;
		this.playStartRealMs = 0;
		this.playStartVirtualMs = 0;
	}

	/** Loads a new set of events and range, resetting the clock to the start of the range. */
	setTimeline(events: TimelineEvent[], timeRangeMs: TimeRangeMs): void {
		this.pause();
		this.events = events;
		this.timeRangeMs = timeRangeMs;
		this.currentTimeMs = timeRangeMs.fromMs;
		this.nextEventIndex = 0;
		this.callbacks.onTimeUpdate(this.currentTimeMs);
	}

	play(): void {
		if (this.isPlaying) return;
		if (this.currentTimeMs >= this.timeRangeMs.toMs) this.seekTo(this.timeRangeMs.fromMs);

		this.isPlaying = true;
		this.playStartRealMs = performance.now();
		this.playStartVirtualMs = this.currentTimeMs;
		this.callbacks.onPlayStateChange(true);
		this.rafHandle = requestAnimationFrame(this._tick);
	}

	pause(): void {
		if (this.rafHandle !== undefined) cancelAnimationFrame(this.rafHandle);
		this.rafHandle = undefined;
		if (this.isPlaying) this.callbacks.onPlayStateChange(false);
		this.isPlaying = false;
	}

	togglePlay(): void {
		if (this.isPlaying) this.pause();
		else this.play();
	}

	setSpeed(speed: number): void {
		this.speed = speed;
		if (this.isPlaying) {
			this.playStartRealMs = performance.now();
			this.playStartVirtualMs = this.currentTimeMs;
		}
	}

	/** Jumps the clock to a specific time, replaying every event up to it instantly (no packet animation). */
	seekTo(timeMs: number): void {
		const clamped: number = Math.min(Math.max(timeMs, this.timeRangeMs.fromMs), this.timeRangeMs.toMs);
		this.currentTimeMs = clamped;
		this.nextEventIndex = this.events.findIndex((event: TimelineEvent): boolean => event.timestampMs > clamped);
		if (this.nextEventIndex === -1) this.nextEventIndex = this.events.length;

		this.callbacks.onSeek(this.events.slice(0, this.nextEventIndex));
		this.callbacks.onTimeUpdate(this.currentTimeMs);

		if (this.isPlaying) {
			this.playStartRealMs = performance.now();
			this.playStartVirtualMs = this.currentTimeMs;
		}
	}
}
