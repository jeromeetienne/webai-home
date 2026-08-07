# Directory Context: `/packages/docker_server`

## Purpose

A Linux Docker image that runs [`packages/gateway`](../gateway) and serves the built browser page from [`packages/worker_webpage`](../worker_webpage) as static files, so a worker browser tab can be opened straight from the container.

## Key Exports & Entry Points

- `docker/Dockerfile` and `docker/Dockerfile.dockerignore`: the image. It is built from the repository root, because it copies from several workspaces.
- `docker/docker-compose.yml`: the service definition. Every script in `package.json` runs `docker compose` with `--project-directory ../..`, so the build context is the repository root.
- `src/static_server.mjs`: the small static file server that serves the built worker browser page next to the gateway.
- `package.json` scripts: `build`, `start`, `stop`, `restart`, and `logs`.

## Local Rules & Boundaries

- `packages/worker_webpage` is a browser page, not a server, so it cannot run inside the container as a worker. A completion request only returns an answer once a browser tab on some machine outside the container has that page open and is connected to the gateway.
- The OpenAI-compatible server from [`packages/consumer_openai`](../consumer_openai) is deliberately not in this image, because one deployment of that server is one account and running it in a publicly reachable container debits every caller's consumption to the container operator's account. See [issue #139](https://github.com/webai-at-home/webai-at-home/issues/139).
- The gateway's account file and ledger file must be written under the `/data` volume inside the image, not next to the source, so they survive a redeploy.
- This package has no automated tests. `npm test --workspace @webai/docker-server` prints that fact and points at the manual verification steps in [`README.md`](README.md).
- Pushing to `main` triggers a live redeploy of this image on the deployment host, so a change here reaches the running deployment as soon as it is pushed.
