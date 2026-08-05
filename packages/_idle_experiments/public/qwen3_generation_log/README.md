# Qwen3-0.6B generation log

Experiment 02 of [`@webai/idle-experiments`](../../README.md), built for [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83).

Every other experiment in this package measures a stand-in for real work: a timer, an animation frame counter, a fixed computation loop. This one measures the real thing. It loads Qwen3-0.6B-ONNX through ONNX Runtime Web and generates an answer to the same fixed prompt over and over, forever, logging each cycle's duration and tokens per second against the tab's visibility, its focus, and whether the quiet tone was playing at the time.

That makes this the experiment that actually settles issue #83. A worker browser tab is meant to sit unattended doing volunteer work, and the only number that decides whether the tab is worth anything while it is not on screen is how fast it generates.

The model loading and generation logic is this experiment's own copy, not shared with `@webai/onnx-experiments`, matching how every experiment in this package keeps its own copy of what it needs. The first load downloads about 570 megabytes, cached afterward in IndexedDB. WebGPU is used when available, WebAssembly otherwise.

## Run

```sh
npm run dev --workspace @webai/idle-experiments
```

Open the printed local address and follow the link to this experiment, or go straight to `qwen3_generation_log/`.

Run it in a real browser window you can hide and reveal yourself. A tab that merely reports itself as hidden inside an embedded or automated browser view is not the same thing, and measuring one of those produced a badly wrong answer during this package's own development — see the note at the end.

## Test it

1. Leave the tab on screen for a minute and note the tokens per second figure the log settles on. This is the baseline.
2. Switch to another tab, or a window that fully covers this one, and leave it for a minute. Do not touch the button yet.
3. Click "Start quiet tone", then hide the tab again for another minute.
4. Compare the three groups of rows. Every row records the visibility and the tone state it was measured under, so the log reads back without notes.

Step 2 before step 3 matters. Clicking the button early produces a log with no tone-stopped rows in it at all, which loses half the comparison.

## What was measured

Measured on 2026-08-05 in a real Chrome window, on WebGPU, 26 tokens per generation cycle:

| Condition | Cycles | Mean tokens per second |
|---|---|---|
| On screen, no tone | 53 | 22.7 |
| Hidden, no tone | 52 | **8.4** |
| On screen, tone running | 52 | 25.3 |
| Hidden, tone running | 170 | **25.7** |

A hidden tab generates about 2.7 times slower with no mitigation. With the quiet tone playing the penalty disappears completely, and it does not come back across three separate hidden stretches spanning several minutes.

Two caveats on those numbers:

- The no-tone and tone-running figures come from two separate sessions rather than one session containing both, because the tone was started before generation began in the second run. The effect is far too large to be an artefact of that, but the tidy version of the evidence — all four groups in one log — has not been captured yet.
- An earlier attempt to measure this inside an embedded automated browser view reported 25.1 tokens per second while the tab called itself hidden, and led to the wrong conclusion that hiding a tab costs nothing. A tab that an automated view reports as hidden is still being driven at full speed. Only a real browser window reproduces the real behaviour.

See [`../../README.md`](../../README.md) for the other experiments in this package.
