# Silent audio trick log

Experiment 04 of [`@webai/idle-experiments`](../../README.md), built for [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83).

A commonly suggested workaround for a slowed-down hidden tab is to keep the tab producing audio, on the theory that a browser treats a tab that is playing audio differently from a silent one. This is not folklore: Chrome's own [background tabs article](https://developer.chrome.com/blog/background_tabs) lists audio playback among the exemptions from background tab timer throttling. This experiment tests whether the exemption behaves the way the article says.

The page runs the identical measurement as [`../visibility_timer_log`](../visibility_timer_log) — timer drift, animation frame count, and a fixed 15,000,000-iteration computation loop — with one addition: a button that starts a very quiet continuous tone. Because the measurement is identical, the log can be compared directly against experiment 01's log taken under the same conditions.

The tone is a 30 hertz oscillator at a gain of 0.001, faint to inaudible on most speakers. It is deliberately not silent: a tone at exactly zero gain may or may not count as playing audio to the browser heuristic under test, and the trick being tested is the audible-but-quiet one.

## Run

```sh
npm run dev --workspace @webai/idle-experiments
```

Open the printed local address and follow the link to this experiment, or go straight to `silent_audio_log/`.

## Test it

1. Click "Start quiet tone". Browsers require a click before they allow audio to start, so this cannot happen on page load.
2. Leave the tab as it is for about 30 seconds and watch the log settle.
3. Move the window to a corner of the screen, not covered by anything, and work in a different window without clicking back into this one.
4. Come back and compare the timer drift and computation loop rows against experiment 01's log taken under the same conditions without the tone.

## What was measured

Measured on 2026-08-05 in a hidden tab, with the tone started partway through a single continuous run:

- Before the tone: timer drift held at +989 to +1003 milliseconds, the same once-per-second clamp experiment 01 shows.
- The moment the tone started: drift dropped to between +0 and +3 milliseconds and stayed there for the rest of the run.
- The computation loop was unchanged either way, 222 to 251 milliseconds before and 222 to 236 milliseconds after.

The window had regained focus about a minute before the tone started, with no effect on drift at all, so the tone is the cause rather than the focus change.

Note what this experiment does and does not show. It proves the quiet tone removes timer clamping. It says nothing about generation speed, because the computation loop here was never slowed in the first place. That second and more important question is answered in [`../qwen3_generation_log`](../qwen3_generation_log), which carries the same tone and measures it against real model generation — where the tone turned out to recover a roughly threefold loss.

See [`../../README.md`](../../README.md) for the other experiments in this package.
