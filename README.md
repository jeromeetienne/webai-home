# webai-home

Monorepo for the two-browser distributed formula pipeline described in [issue #2](https://github.com/jeromeetienne/webai-home/issues/2).

## Packages

- `packages/protocol` — shared validated message and task types.
- `packages/central_server` — HTTP health endpoint, WebSocket registration, task scheduling, and signalling relay.
- `packages/volunteer_browser` — browser tab that registers and runs the `multiply` and `add` formula stages.
- `packages/admin_browser` — browser view of connected tabs and task updates.
- `packages/task_client` — command-line JSON task submitter.

## Run

```sh
npm install
npm run dev:server
npm run dev --workspace @webai/task-client -- 5
```

Serve the two browser package directories from a local static server and open two volunteer tabs plus the administrator page. The central server listens on port `8787` by default. The first formula stage multiplies by `2`; the second formula stage adds `7`.
