# Web Worker processor offload log

Experiment 03 of [`@webai/idle-experiments`](../../README.md), built for [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83).

Tests one specific idea: that moving heavy computation off the main thread and onto a dedicated Web Worker protects it from whatever the browser does to a tab that is not on screen.

The page runs the identical fixed 15,000,000-iteration computation loop from [`../visibility_timer_log`](../visibility_timer_log) in two places at the same time — on the main thread and on a Web Worker — and reports both into one log, along with each one's own 1000 millisecond timer drift. Because both run under the same conditions in the same page, their numbers can be compared directly without lining up two separate runs.

If the Web Worker's numbers stay flat while the main thread's degrade, offloading is a real mitigation worth building into the worker webpage. If both degrade together, it is not.

## Run

```sh
npm run dev --workspace @webai/idle-experiments
```

Open the printed local address and follow the link to this experiment, or go straight to `web_worker_cpu_log/`.

## Test it

1. Leave the tab on screen for about 30 seconds and watch the log settle, with rows from both the main thread and the Web Worker interleaved.
2. Move the window to a corner of the screen, not covered by anything, and work in a different window without clicking back into this one.
3. Come back and compare: did the main thread and Web Worker durations move together, or did one stay flat while the other grew?
4. Repeat with the window fully covered or minimized.

## What was measured, and why it is not settled

Measured on 2026-08-05 in a hidden tab, and this one produced the least trustworthy result in the package:

- For roughly the first 15 seconds, the Web Worker's computation loop held steady at 211 to 231 milliseconds while the main thread's 1000 millisecond timer was already clamped to about 2000 milliseconds. That looked like offloading working exactly as hoped.
- Then both the Web Worker and the main thread collapsed together, to between 850 and 1462 milliseconds per loop — roughly five to six times slower.

That collapse is unexplained and should not be treated as established browser behaviour. It did not reproduce in [`../silent_audio_log`](../silent_audio_log), which sat hidden for over two minutes in the same session with its computation loop flat at 222 to 251 milliseconds throughout. The most likely explanations are that this page saturates the processor by running two continuous loops at once, or that unrelated load on the machine landed during the measurement.

Rerun this one before building anything on it. If the collapse is real it matters a great deal, and if it is an artefact of this page's own design then the first 15 seconds are the whole story and offloading looks genuinely useful.

See [`../../README.md`](../../README.md) for the other experiments in this package.
