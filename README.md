# webai-home

Monorepo for the two-browser distributed formula pipeline described in [issue #2](https://github.com/jeromeetienne/webai-home/issues/2).

## Packages

- `packages/protocol` — shared validated message and task types.
- `packages/central_server` — HTTP health endpoint, WebSocket registration, task scheduling, and signalling relay.
- `packages/central_server/public` — administrator, volunteer, and iframe debug pages with page-specific browser scripts and stylesheets.
- `packages/task_client` — command-line JSON task submitter.

## Run

```sh
npm install
npm run dev:server
npm run dev --workspace @webai/task-client -- 5
```

Open `http://localhost:8787/volunteer` in two browser tabs and `http://localhost:8787/admin` in the administrator browser tab. The central server serves all pages and browser assets from `packages/central_server/public` and listens on port `8787` by default. The first formula stage multiplies by `2`; the second formula stage adds `7`.
