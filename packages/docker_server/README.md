# Docker image: Gateway, consumer_openai, and the worker page

A Linux Docker image that runs [`packages/gateway`](../gateway) and the OpenAI-compatible server from [`packages/consumer_openai`](../consumer_openai) together in one container, plus the built browser page from [`packages/worker_webpage`](../worker_webpage), served as static files so a worker browser tab can be opened straight from the container.

The command line consumer package (`packages/consumer_cli`) is included only as a library, because `packages/consumer_openai` depends on it (`ConsumerClient`, `TaskInputFactory`, `taskTypeNames`). Its own command line program is never started in this image.

`packages/worker_webpage` is a browser page, not a server, so it cannot itself run inside the container as a worker. A completion request only returns an answer once at least one browser tab, running on some machine outside the container, has that page open and is connected to the gateway.

## Ports

| Port | Service |
| --- | --- |
| `8787` | Gateway HTTP and WebSocket server ([`packages/gateway`](../gateway)) |
| `8788` | OpenAI-compatible HTTP server ([`packages/consumer_openai`](../consumer_openai)) |
| `8789` | The built worker browser page ([`packages/worker_webpage`](../worker_webpage)), served as static files |

The two ports the underlying issue names are `8787` and `8788`; `8789` was added afterward so the worker browser page a real end-to-end test needs is reachable from this same image, without running a separate `npm run dev --workspace @webai/worker-webpage` on the host.

## Layout

- [`package.json`](package.json) — the npm scripts below.
- [`docker/`](docker) — the container image definition: the [`Dockerfile`](docker/Dockerfile), its matching [`Dockerfile.dockerignore`](docker/Dockerfile.dockerignore), the [`docker-entrypoint.sh`](docker/docker-entrypoint.sh) it runs, and [`docker-compose.yml`](docker/docker-compose.yml).
- [`src/`](src) — code the image runs that is not one of the existing packages: [`static_server.mjs`](src/static_server.mjs), the worker page's static file server.

## npm scripts

[`package.json`](package.json) wraps the `docker` and `docker compose` commands used throughout this document, each already pointed at [`docker/docker-compose.yml`](docker/docker-compose.yml), so none of these need the `-f` path spelled out. Run them from this directory, or from anywhere in the repository with `--workspace @webai/docker-server`:

| Script | Runs | Does |
| --- | --- | --- |
| `npm run build` | `docker compose -f docker/docker-compose.yml build` | Builds the image (see [Build](#build)) |
| `npm run start` | `docker compose -f docker/docker-compose.yml up -d` | Starts the container in the background (see [Start](#start)) |
| `npm run stop` | `docker compose -f docker/docker-compose.yml down` | Stops and removes the container (see [Shutdown](#shutdown)) |
| `npm run restart` | `docker compose -f docker/docker-compose.yml restart` | Restarts the running container without rebuilding it |
| `npm run logs` | `docker compose -f docker/docker-compose.yml logs -f` | Follows both programs' startup and error output (see [Logs](#logs)) |
| `npm test` | prints a pointer to this file | There is nothing to automate here; this only exists so the repository's root `npm test` (which runs every workspace's `test` script) does not fail on this package |

`npm run start` reads its environment variables and port mapping from [`docker/docker-compose.yml`](docker/docker-compose.yml) rather than from a command line, so edit that file (or override with `docker compose run -e ...`) to change them — see [Configuration](#configuration).

## Build

Build from the repository root, because the image needs the whole npm workspace (the root `package.json`, the root lockfile is not used — see the note in the [`Dockerfile`](docker/Dockerfile) — and every package's source):

```bash
docker build -f packages/docker_server/docker/Dockerfile -t webai-at-home .
```

Or with Compose:

```bash
docker compose -f packages/docker_server/docker/docker-compose.yml build
```

Or with the npm scripts below (already resolve the paths above): `npm run build --workspace @webai/docker-server`.

## Start

```bash
docker run -d --name webai-at-home \
  -p 8787:8787 -p 8788:8788 -p 8789:8789 \
  -e GATEWAY_AUTH_TOKEN=change-me \
  -v webai-at-home-data:/data \
  webai-at-home
```

Or:

```bash
docker compose -f packages/docker_server/docker/docker-compose.yml up -d
```

Or with the npm scripts: `npm run start --workspace @webai/docker-server`.

The `/data` volume holds the gateway's durable task state file (`gateway-state.json` by default), so queued and in-flight tasks survive a container restart.

## Configuration

Neither the gateway nor `consumer_openai` reads environment variables directly — both only read command line options. [`docker-entrypoint.sh`](docker/docker-entrypoint.sh) converts the environment variables below into the matching command line options when it starts each program.

| Variable | Default | Passed as |
| --- | --- | --- |
| `GATEWAY_PORT` | `8787` | the gateway's `--port` |
| `GATEWAY_AUTH_TOKEN` | `development-token` | the gateway's `--auth-token` — the bearer token every connection (workers, the home page, `consumer_openai`) must present |
| `GATEWAY_STATE_FILE` | `/data/gateway-state.json` | the gateway's `--state-file` |
| `CONSUMER_OPENAI_PORT` | `8788` | `consumer_openai`'s `--port` |
| `GATEWAY_WS_URL` | `ws://127.0.0.1:8787` | `consumer_openai`'s `--gateway-url` — the gateway's WebSocket address; change this to reach a gateway running in a different container or host, rather than assuming `localhost` refers to this same container |
| `CONSUMER_OPENAI_AUTH_TOKEN` | the value of `GATEWAY_AUTH_TOKEN` | `consumer_openai`'s `--auth-token` — set this separately only if `consumer_openai` must authenticate with a gateway that uses a different token than this container's own gateway process |
| `CONSUMER_OPENAI_API_KEY` | unset (no key required) | `consumer_openai`'s `--api-key` — the key a caller of the OpenAI-compatible server must present |
| `CONSUMER_OPENAI_NAME` | `consumer_openai server` | `consumer_openai`'s `--name` |
| `WORKER_PORT` | `8789` | the port the built worker page is served on |

**Set `GATEWAY_AUTH_TOKEN` to a real value in anything but local testing.** The default `development-token` is the same default the gateway, `consumer_openai`, and the worker browser page all fall back to on their own, so leaving it unset only works because every part agrees on the same well-known placeholder.

## Send an OpenAI-compatible request

```bash
curl http://localhost:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "dev_formula", "messages": [{"role": "user", "content": "5"}]}'
```

`dev_formula` is the cluster's development formula task: it multiplies the submitted number by two in one stage and adds seven in the next, so `5` comes back as `17`. It needs no downloaded model and no graphics processor, so it is the quickest way to prove the whole path end to end. This only returns an answer once the two worker browser tabs below are connected — otherwise the request waits for `--connection-wait-ms` (5 seconds by default) and then reports that no worker is available, which is an expected answer in a cluster of volunteer browsers, not a fault.

## Open the gateway and connect a worker

- The gateway's home page: `http://localhost:8787/home`
- The worker browser page, built from `packages/worker_webpage` and served from this same container: `http://localhost:8789/?gatewayUrl=http://localhost:8787&authToken=<GATEWAY_AUTH_TOKEN>`

`dev_formula` uses two pipeline stages, so open the worker page in two separate browser tabs (on the host machine, or any machine that can reach the published ports) before sending a request.

## Check the connection state

```bash
curl http://localhost:8788/health
```

```json
{ "ok": true, "isGatewayConnected": true, "tasksInFlight": 0 }
```

`isGatewayConnected` reports whether `consumer_openai` currently holds a registered connection to the gateway inside the container — this becomes `true` shortly after startup and does not depend on a worker browser tab being connected.

## Logs

```bash
docker logs -f webai-at-home
```

or `npm run logs --workspace @webai/docker-server`, shows both programs' own startup and error output. Each program also writes its own message log under `packages/gateway/logs` and `packages/consumer_openai/logs` inside the container; read them with:

```bash
docker exec webai-at-home ls packages/gateway/logs packages/consumer_openai/logs
docker exec webai-at-home cat packages/gateway/logs/<file>
```

## Shutdown

```bash
docker stop webai-at-home
```

Or with the npm scripts: `npm run stop --workspace @webai/docker-server`.

The entrypoint script forwards `SIGTERM` to the gateway, `consumer_openai`, and the worker page's static file server, and both application programs already close their own connections and servers on `SIGTERM` (see `Cli.shutdown` in each package's `cli.ts`).
