import type { TimeRangeMs, TimelineEvent } from "./types.js";

export interface PlaybackSegment {
	event: TimelineEvent;
	startMs: number;
	endMs: number;
}

export interface PlaybackCallbacks {
	onSeek: (eventsUpToNow: TimelineEvent[]) => void;
	onTimeUpdate: (visualTimeMs: number, logTimeMs: number, activeSegment: PlaybackSegment | undefined, packetProgress: number) => void;
	onPlayStateChange: (isPlaying: boolean) => void;
	onFinish: () => void;
}

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

	setPacketDuration(durationMs: number): void {
		if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs === this.packetDurationMs) return;
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

	getPacketDuration(): number {
		return this.packetDurationMs;
	}

	getVisualDuration(): number {
		return this.timeRangeMs.toMs;
	}

	play(): void {
		if (this.isPlaying) return;
		if (this.currentTimeMs >= this.timeRangeMs.toMs) this.seekTo(this.timeRangeMs.fromMs);
		this.isPlaying = true;
		this.playStartRealMs = performance.now();
		this.playStartVisualMs = this.currentTimeMs;
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

	stop(): void {
		this.pause();
		this.seekTo(this.timeRangeMs.fromMs);
	}

	setSpeed(speed: number): void {
		this.speed = speed;
		if (this.isPlaying) {
			this.playStartRealMs = performance.now();
			this.playStartVisualMs = this.currentTimeMs;
		}
	}

	setLoop(looping: boolean): void {
		this.isLooping = looping;
	}

	seekTo(visualTimeMs: number): void {
		this._updateAt(Math.min(Math.max(visualTimeMs, this.timeRangeMs.fromMs), this.timeRangeMs.toMs));
		if (this.isPlaying) {
			this.playStartRealMs = performance.now();
			this.playStartVisualMs = this.currentTimeMs;
		}
	}

	seekBy(offsetMs: number): void {
		this.seekTo(this.currentTimeMs + offsetMs);
	}

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
			const segment: PlaybackSegment = { event, startMs: cursorMs, endMs: cursorMs + this.packetDurationMs };
			cursorMs += Math.max(this.packetDurationMs, realGapMs);
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
