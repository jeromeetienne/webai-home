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

The experiment pages are measurements and demonstrations, not production code.
