///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Background — keeps exactly one offscreen document alive, playing audio
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The service worker's only job is making sure the offscreen document exists. All of the actual
 * measurement — the tone, the timer-drift check, the CPU benchmark — runs inside that document,
 * in offscreen.js, not here: a service worker cannot play audio and is not meant to run
 * indefinitely on its own, so it cannot be the thing under test.
 *
 * This file has no local tsconfig, so it is plain JavaScript with JSDoc types rather than
 * TypeScript, per this repository's convention for standalone scripts outside a TypeScript
 * project.
 */
class Background {
	/** Creates the offscreen document if one does not already exist. */
	static async ensureOffscreenDocument() {
		const hasDocument = await chrome.offscreen.hasDocument();
		if (hasDocument) return;
		await chrome.offscreen.createDocument({
			url: 'offscreen.html',
			reasons: ['AUDIO_PLAYBACK'],
			justification: 'Plays a continuous quiet tone so this document is not an idle, silent background context, as part of an experiment measuring Chrome background-tab throttling (webai-at-home issue #83).',
		});
	}
}

chrome.runtime.onInstalled.addListener(() => {
	void Background.ensureOffscreenDocument();
});
chrome.runtime.onStartup.addListener(() => {
	void Background.ensureOffscreenDocument();
});
// A Manifest V3 service worker re-runs this whole file from the top every time it wakes from
// being terminated, so this also covers the case where the worker restarts on some later event
// with the offscreen document already gone for an unrelated reason.
void Background.ensureOffscreenDocument();
