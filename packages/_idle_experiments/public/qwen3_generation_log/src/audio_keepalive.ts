///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AudioKeepalive — plays a very quiet, continuous tone, on the theory that
//	Chrome treats a tab that is producing audio differently from a silent one
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Copied from packages/_idle_experiments/public/silent_audio_log/src/audio_keepalive.ts without
 * changes. Kept as its own copy rather than an import, matching how every experiment in this
 * repository — including this page's own model_helper.ts — keeps its own copy of the helpers it
 * needs instead of sharing them across experiment folders.
 *
 * silent_audio_log measures the quiet tone against timer drift, animation frames, and a synthetic
 * computation loop. This page measures the same tone against the one number that decides whether
 * the trick is worth building into the worker webpage: how fast Qwen3-0.6B-ONNX actually
 * generates while the tab is not on screen.
 */

/**
 * The gain applied to the tone.
 *
 * Not zero: a tone at exactly zero gain may or may not count as "playing audio" to whichever
 * browser heuristic this experiment is testing, and the point is to test the specific, commonly
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
	 * start audio output otherwise — which this experiment cannot work around, since the trick
	 * being tested depends on the audio actually being audible to the browser's own heuristics.
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

	/** Reports the tone's current state. */
	static state(): AudioKeepaliveState {
		if (AudioKeepalive.audioContext === undefined) {
			return 'stopped';
		}
		return AudioKeepalive.audioContext.state === 'running' ? 'running' : 'suspended';
	}
}
