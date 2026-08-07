///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AudioKeepalive — plays a very quiet, continuous tone so a hidden tab keeps its full
//	generation speed
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Copied from
 * `packages/_idle_experiments/public/qwen3_generation_log/src/audio_keepalive.ts`
 * without changes.
 *
 * That experiment measured a hidden tab generating about 2.7 times slower than one left on
 * screen, and found that this quiet tone removes the slowdown entirely (see
 * [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83) and the experiment's
 * own README). This copy carries the same trick into the worker webpage itself, so a worker
 * browser tab left unattended in the background keeps doing volunteer work at full speed (see
 * [issue #120](https://github.com/webai-at-home/webai-at-home/issues/120)).
 */

/**
 * The gain applied to the tone.
 *
 * Not zero: a tone at exactly zero gain may or may not count as "playing audio" to whichever
 * browser heuristic this trick relies on, and the point is to play the specific, commonly
 * suggested trick of an audible-but-quiet tone, not a technically-silent one. At this gain and
 * frequency the tone should be faint to inaudible on most speakers.
 */
const TONE_GAIN = 0.001;
/** Near the bottom of the range of human hearing, chosen to keep the tone as unobtrusive as possible. */
const TONE_FREQUENCY_HZ = 30;

/** Whether the tone is off, playing, or suspended by the browser (for example after a tab is hidden long enough). */
export type AudioKeepaliveState = 'stopped' | 'running' | 'suspended';

/** Starts and reports on a very quiet, continuous tone used to keep this tab classified as playing audio. */
export class AudioKeepalive {
	private static audioContext: AudioContext | undefined;

	/**
	 * Starts the tone.
	 *
	 * Must be called from a user gesture, such as a button click, because browsers refuse to
	 * start audio output otherwise — which this page cannot work around, since the trick being
	 * used depends on the audio actually being audible to the browser's own heuristics.
	 *
	 * Every statement here is synchronous on purpose. Called as the first statement of a click
	 * handler, the browser still treats the gesture as active and lets the AudioContext start in
	 * the running state. Called after an await — loading the model, reaching a server — the
	 * gesture may already have expired, and the browser creates the AudioContext suspended
	 * instead, which silently defeats the whole trick.
	 */
	static start(): void {
		if (AudioKeepalive.audioContext !== undefined) {
			return;
		}
		const audioContext = new AudioContext();
		const oscillator = audioContext.createOscillator();
		const gain = audioContext.createGain();
		oscillator.frequency.value = TONE_FREQUENCY_HZ;
		gain.gain.value = TONE_GAIN;
		oscillator.connect(gain);
		gain.connect(audioContext.destination);
		oscillator.start();
		AudioKeepalive.audioContext = audioContext;
	}

	/** Stops the tone and releases the audio resources it was using. */
	static stop(): void {
		if (AudioKeepalive.audioContext === undefined) {
			return;
		}
		void AudioKeepalive.audioContext.close();
		AudioKeepalive.audioContext = undefined;
	}

	/** Reports the tone's current state. */
	static state(): AudioKeepaliveState {
		if (AudioKeepalive.audioContext === undefined) {
			return 'stopped';
		}
		return AudioKeepalive.audioContext.state === 'running' ? 'running' : 'suspended';
	}
}
