# `@webai/gateway`

Central HTTP and WebSocket gateway for the WebAI distributed pipeline.

The gateway authenticates and registers consumer and worker browser
connections, assigns pipeline stages, tracks task progress, persists task state
when configured, and relays signalling messages. Its home page observes
gateway activity without registering as a device. Built-in pipelines support
the development formula, Qwen3-0.6B sharded inference, and Chrome's Gemma Nano
model.

## Run

From the repository root:

```sh
npm run dev --workspace @webai/gateway
```

The default port is `8787` and the default bearer token is
`development-token`. Use `--port` or `-p` to choose another port:

```sh
npm run dev --workspace @webai/gateway -- --port 9000
```

Other command-line options control assignment leases, queued-task deadlines,
retry attempts, durable state, authentication, per-principal task limits,
session lifetime, additional pipeline definitions, and device activity
coalescing. See `npm run dev --workspace @webai/gateway -- --help` for the
current option list.

## Pages and endpoints

Each HTML page and its assets are stored in its own directory under `web/`. Browser TypeScript files use `src/main.ts`, and stylesheets use `css/main.css`.

- `/` or `/home` — gateway landing page.
- `/monitor` — live gateway monitor showing connected devices, tasks, stages, and recent events.
- `/debug` — index of the current gateway debug pages.
- `/debug_iframe` — page that displays the gateway home page and the standalone worker page in frames.
- `/debug_iframe_dev_formula` — formula-specific debug page with separate multiply and add worker frames.
- `/debug_iframe_llm_qwen3_0_6b_sharded` — language-model debug page with one worker frame for each shard.
- `/debug_iframe_llm_gemma_nano_chrome_full` — Gemma Nano debug page with one worker frame.
- `/health` — JSON health response with the current worker count.
- `/diagnostics` — authenticated `POST` endpoint used by worker browsers to send diagnostic entries.

The WebSocket server uses the same port as the HTTP server. Every connection
must authenticate with the configured bearer token before it can register or
submit work. A worker browser page is served by
[`@webai/worker-webpage`](../worker_webpage); the gateway does not provide the
worker page itself.

## Build and test

```sh
npm run build --workspace @webai/gateway
npm run test --workspace @webai/gateway
```

For a production build, run `npm run build --workspace @webai/gateway` and
then `npm run start --workspace @webai/gateway`. The default state file is
`gateway-state.json`; gateway message logs and relayed worker logs are written
under `packages/gateway/logs` while the gateway runs.
