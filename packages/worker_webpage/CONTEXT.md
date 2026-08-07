# Directory Context: `/packages/worker_webpage`

## Purpose

The browser page a volunteer opens to contribute computing time. The page connects to the central gateway over a WebSocket, advertises which stages it can run, accepts a stage assignment, runs the model work in the browser tab, and sends the result back.

## Key Exports & Entry Points

- `web/index.html` and `web/src/main.ts`: the page itself. `npm run dev --workspace @webai/worker-webpage` serves it with Vite on port `8789`; `npm run build --workspace @webai/worker-webpage` builds the static files the Docker image serves.
- `web/src/connection/`: `gateway_config.ts` reads the query parameters, `gateway_link.ts` holds the WebSocket connection, `worker_stage_offer.ts` advertises the stages, `lease_heartbeat.ts` keeps a stage assignment alive, `worker_account.ts` and `account_key_store.ts` hold the account key pair, and `diagnostics_reporter.ts` reports back.
- `web/src/stages/`: one stage helper per stage the page can run — `stage_helper_dev_formula.ts`, `stage_helper_llm_qwen3_0_6b_sharded.ts`, `stage_helper_llm_qwen3_5_0_8b_full.ts`, and `stage_helper_llm_gemma_nano_chrome_full.ts`.
- `web/src/page/`: `page_markup.ts`, `page_elements.ts`, `worker_event_log.ts`, `theme_toggle.ts`, `audio_keepalive.ts`, which plays a quiet tone so a backgrounded tab is not throttled, and `screen_wake_lock.ts`, which asks the system to keep the screen on while the tab is visible.

## Local Rules & Boundaries

- This is a browser page, not a server. It cannot run inside the Docker container as a worker; the container only serves the built files.
- Every setting comes from a query parameter on the page address — `gatewayUrl`, `authToken`, `workerName`, and repeated `enabledStages` — never from an environment variable.
- Adding a stage means adding one `web/src/stages/stage_helper_<stage name>.ts` file whose name is the stage name from [`docs/naming_scheme.md`](../../docs/naming_scheme.md), and registering it where the other stage helpers are registered.
- Message shapes come from `@webai/protocol`. Do not restate a wire shape here.
- There is no unit test run; `npm test --workspace @webai/worker-webpage` runs the type check. The end-to-end tests that drive this page live in [`packages/consumer_openai/tests`](../consumer_openai/tests).
