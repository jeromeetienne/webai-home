# `@webai/idle-experiments`

Browser experiments about idle time: what a tab's timers, animation frames, and raw computation actually do as the tab moves between focused, visible-but-unfocused, and backgrounded. The package is private, standalone, and not included in the root build script. It does not import from or depend on any other package in this repository, including `@webai/onnx-experiments` — the two are separate on purpose, so one can be read and run without the other.

This package exists because of [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83): a worker browser tab is meant to sit in the background doing volunteer work, and a backgrounded tab in Chrome runs measurably slower and more unpredictably than a visible one. Before changing any production code to work around that, these experiments measure what the browser is actually doing, moment to moment, independent of any worker or model.

## Run

From the repository root:

```sh
npm run dev --workspace @webai/idle-experiments
```

Open the local URL printed by Vite. The home page links to each experiment.

## Build and type check

```sh
npm run typecheck --workspace @webai/idle-experiments
npm run build --workspace @webai/idle-experiments
npm run preview --workspace @webai/idle-experiments
```

## Experiments

- [`public/visibility_timer_log`](public/visibility_timer_log) — logs `document.visibilityState` and focus changes, how far a nominal 1-second timer drifts from 1 second, how many animation frames land between ticks, and how long a fixed amount of raw computation takes, once a second, for as long as the page is open. No model, no server: open it, move the window around, and read the log.
- [`public/qwen3_generation_log`](public/qwen3_generation_log) — loads Qwen3-0.6B-ONNX through ONNX Runtime Web (own copy of the loading and generation logic, not shared with `@webai/onnx-experiments`) and generates a short answer to the same fixed prompt over and over, logging each cycle's duration and tokens/second against this tab's visibility and focus at the time. The first load downloads about 570 MB, cached afterward in IndexedDB. Uses WebGPU when available, WebAssembly otherwise.
- [`public/web_worker_cpu_log`](public/web_worker_cpu_log) — runs the identical fixed CPU workload from `visibility_timer_log` on both the main thread and a dedicated Web Worker at the same time, logging both into one combined log so their throughput and timer drift can be compared directly under the same backgrounding conditions.
- [`public/silent_audio_log`](public/silent_audio_log) — the same calibration measurement as `visibility_timer_log`, plus a button that starts a very quiet, continuous tone, to test whether a tab that is audibly playing audio is throttled differently from a silent one.
- [`extension/offscreen_audio_log`](extension/offscreen_audio_log) — not a page. A real, local-only Chrome extension using `chrome.offscreen` to run the same tone-plus-calibration measurement in a hidden document that never belongs to any tab or window at all, so there is nothing to background, cover, or minimize. Loaded through `chrome://extensions` in Developer Mode, not through Vite; see its own README for how to load and test it. Built from documented Chrome behavior (audio-playing contexts are exempt from background-tab timer throttling) rather than folklore — see the exemption list in [Chrome's background-tabs blog post](https://developer.chrome.com/blog/background_tabs).

Every experiment after the first is a variation on the same calibration measurement, so results can be compared across pages under the same conditions: run one page focused, backgrounded, and corner-window-visible, then repeat with another page to see whether the mitigation it tests actually changes the numbers.

The experiment pages are measurements and demonstrations, not production code.
