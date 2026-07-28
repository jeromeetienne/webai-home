# `@webai/gateway`

Central HTTP and WebSocket gateway for the WebAI distributed formula pipeline.

The gateway registers consumer and worker browser connections, assigns the `multiply` and `add` stages to worker browsers, tracks task progress, and relays signalling messages. Its home page observes gateway activity without registering as a device.

## Run

From the repository root:

```sh
npm run dev:gateway
```

The default port is `8787`. Use `--port` or `-p` to choose another port:

```sh
npm run dev --workspace @webai/gateway -- --port 9000
```

## Pages and endpoints

Each HTML page and its assets are stored in its own directory under `public/`. Browser TypeScript files use `src/main.ts`, and stylesheets use `css/main.css`.

- `/` or `/home` — gateway home page.
- `/debug_iframe` — page that displays the gateway home page and the standalone worker page in frames.
- `/debug_iframe_formula` — formula-specific debug page with separate multiply and add worker frames.
- `/debug_iframe_llm` — language-model debug page with one worker frame for each shard.
- `/health` — JSON health response with the current worker count.

## Build and test

```sh
npm run build --workspace @webai/gateway
npm run test --workspace @webai/gateway
```
