# Visibility and timer calibration log

Experiment 01 of [`@webai/idle-experiments`](../../README.md), built for [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83).

This is the baseline every other experiment in this package is compared against. It measures the page itself, with no model, no server, and no dependency on the rest of this repository. Once a second, for as long as the page stays open, it records four things:

- The tab's `document.visibilityState` and every change to it.
- The window's focus state and every change to it.
- How far a timer asked to fire after 1000 milliseconds actually drifts from 1000 milliseconds.
- How many animation frames arrived since the previous tick, and how long a fixed 15,000,000-iteration computation loop took.

The last two are the interesting pair: the timer and animation frame numbers show what the browser's scheduler is doing to the page, and the computation loop shows whether the page is actually being given less processor time or merely being woken less often. Those are different problems with different fixes, and separating them is the point of this experiment.

## Run

```sh
npm run dev --workspace @webai/idle-experiments
```

Open the printed local address and follow the link to this experiment, or go straight to `visibility_timer_log/`.

## Test it

1. Leave the tab on screen for about 30 seconds and let the log settle into a steady rhythm.
2. Move the window to a corner of the screen, small and not covered by anything else, then work in a different window that does not overlap it. Do not click back into this window. This tests visible but unfocused.
3. Come back and read the log. Did the timer drift, the animation frame count, or the computation loop time change once the window lost focus but stayed on screen?
4. Repeat with the window fully covered by another window, and again minimized, to see whether either produces a different pattern from visible but unfocused.

## What was measured

Measured on 2026-08-05 in a hidden tab:

- The 1000 millisecond timer settled into firing every 1990 to 2000 milliseconds, a consistent drift of about +1000 milliseconds. This is the documented once-per-second clamp Chrome applies to a hidden tab.
- Animation frames stopped completely — every tick reported 0 frames since the previous one.
- The fixed computation loop stayed flat at 220 to 253 milliseconds throughout, unchanged from its on-screen figure.

That combination is the useful result: while the tab was hidden the browser woke the page half as often, but each unit of work still ran at full speed. Timer clamping and reduced processor time are separate effects, and only the first one showed up here.

See [`../../README.md`](../../README.md) for the other experiments in this package.
