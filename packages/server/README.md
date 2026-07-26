# `@webai/server`

Central HTTP and WebSocket server for the WebAI distributed formula pipeline.

The server registers administrator and volunteer browser connections, assigns the `multiply` and `add` stages to volunteer browsers, tracks task progress, and relays signalling messages.

## Run

From the repository root:

```sh
npm run dev:server
```

The default port is `8787`. Use `--port` or `-p` to choose another port:

```sh
npm run dev --workspace @webai/server -- --port 9000
```

## Pages and endpoints

Each HTML page and its assets are stored in its own directory under `public/`. Browser TypeScript files use `src/main.ts`, and stylesheets use `css/main.css`.

- `/` or `/admin` — administrator page.
- `/volunteer` — volunteer browser page.
- `/debug_iframe` — page that displays the administrator and volunteer pages in frames.
- `/health` — JSON health response with the current volunteer count.

## Build and test

```sh
npm run build --workspace @webai/server
npm run test --workspace @webai/server
```
