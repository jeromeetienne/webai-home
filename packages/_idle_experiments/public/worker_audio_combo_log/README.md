# Web Worker and quiet tone combination log

Experiment 07 of [`@webai/idle-experiments`](../../README.md), built for [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83).

Runs two mitigations at once, in one page, so their combined effect can be read from a single log instead of being pieced together from two separate runs:

- The Web Worker offload from [`../web_worker_cpu_log`](../web_worker_cpu_log) — the same fixed 15,000,000-iteration computation loop on both the main thread and a dedicated Web Worker.
- The quiet tone from [`../silent_audio_log`](../silent_audio_log) — a 30 hertz oscillator at a gain of 0.001, started by a button.

This exists because the two mitigations address different things. The quiet tone is documented to exempt a tab from timer throttling, which governs how often the page is woken. The Web Worker offload is about where the work runs. Whether they help each other, do nothing for each other, or overlap entirely is not answerable from the two separate pages, because their runs were taken at different times under conditions that cannot be matched exactly.

## Run

```sh
npm run dev --workspace @webai/idle-experiments
```

Open the printed local address and follow the link to this experiment, or go straight to `worker_audio_combo_log/`.

## Test it

1. Leave the tab on screen for about 30 seconds and watch the log settle, with rows from both the main thread and the Web Worker interleaved.
2. Hide the tab for a minute with the tone still stopped, then come back and read those rows.
3. Click the button to start the quiet tone, hide the tab again for another minute, and read those rows.
4. Compare the two hidden stretches against each other and against the on-screen baseline.

## What was measured

Nothing yet. This experiment has not been run.

It is worth running for one specific reason. The unexplained result in [`../web_worker_cpu_log`](../web_worker_cpu_log) — where the Web Worker's computation loop held steady for about 15 seconds and then collapsed along with the main thread's, to roughly five times slower — is the loose end in this package. If that collapse is real, this page will show whether the quiet tone prevents it. If the collapse does not reproduce here either, that points at the earlier run being an artefact rather than browser behaviour.

Note that the more decisive question, whether the quiet tone protects real model generation speed, is already answered in [`../qwen3_generation_log`](../qwen3_generation_log): it does, recovering a roughly threefold loss. This page measures a synthetic computation loop rather than a model, so treat it as diagnostic for the Web Worker question rather than as the basis for a decision about the worker webpage.

See [`../../README.md`](../../README.md) for the other experiments in this package.
