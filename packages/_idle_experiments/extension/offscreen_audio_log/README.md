# Offscreen audio trick log

Part of [`@webai/idle-experiments`](../../README.md) and [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83). Unlike the other four experiments in this package, this one is a real (unpublished, local-only) Chrome extension, not a page served by Vite — it exists to test a claim from that issue's research: that a `chrome.offscreen` document playing audio may be treated differently by Chrome's background-tab throttling than an ordinary background tab, because it never belongs to a visible tab at all.

## What it does

- `background.js` is a Manifest V3 service worker whose only job is making sure exactly one offscreen document exists.
- `offscreen.js` runs inside that hidden document: it starts a very quiet, continuous tone (the `AUDIO_PLAYBACK` justification Chrome requires for an offscreen document to stay alive), then runs the same fixed CPU-benchmark and 1-second timer-drift measurement the other experiments in this package use, so results are comparable. Every measurement is written to `chrome.storage.local`.
- `popup.js` only displays that log when you open the extension's icon. It takes no measurement itself and closing it does not stop anything — the offscreen document keeps running independently.

## Load it

1. Open `chrome://extensions` in Chrome.
2. Turn on "Developer mode" (top right).
3. Click "Load unpacked" and select this folder (`packages/_idle_experiments/extension/offscreen_audio_log`).
4. Click the extension's icon in the toolbar to open the popup and confirm rows are appearing under "Log".

## Test it

There is no window or tab to move to a corner here — that is the property under test. Instead:

1. Leave Chrome running and open, then switch to a different application so Chrome itself is not the frontmost app on screen, for a few minutes.
2. Reopen the popup and compare the timer-drift and CPU-benchmark rows logged during that stretch against rows logged while Chrome was in the foreground.
3. If the numbers stay flat regardless of whether Chrome was frontmost, that is a real, working mitigation — running the model as (or from) an offscreen document, rather than in a visible worker tab, would sidestep this issue entirely.

## Remove it

"Load unpacked" extensions stay installed until removed. Go back to `chrome://extensions` and click "Remove" on "Idle-time offscreen audio experiment" when you are done testing.

## Caveat

This experiment was built and syntax-checked but not run end to end — loading a Developer Mode extension requires a real Chrome profile and the `chrome://extensions` UI, which is not something that could be driven the same way the other four experiments were verified in this package. Treat its correctness as unverified until you have loaded it yourself.
