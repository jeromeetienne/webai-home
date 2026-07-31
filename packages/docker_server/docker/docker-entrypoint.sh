#!/bin/bash
# Starts the gateway, the OpenAI-compatible server, and a static file server for the built
# worker page, translating environment variables into the command line options each program
# reads (none of the three read environment variables directly). See
# packages/docker_server/README.md for what each variable configures.
set -euo pipefail

GATEWAY_PORT="${GATEWAY_PORT:-8787}"
GATEWAY_AUTH_TOKEN="${GATEWAY_AUTH_TOKEN:-development-token}"
GATEWAY_STATE_FILE="${GATEWAY_STATE_FILE:-/data/gateway-state.json}"

CONSUMER_OPENAI_PORT="${CONSUMER_OPENAI_PORT:-8788}"
GATEWAY_WS_URL="${GATEWAY_WS_URL:-ws://127.0.0.1:${GATEWAY_PORT}}"
# Defaults to the gateway's own token, so setting GATEWAY_AUTH_TOKEN alone still leaves the two
# servers able to authenticate with each other; set CONSUMER_OPENAI_AUTH_TOKEN separately only
# if the gateway sits behind a different token than this container's own gateway process.
CONSUMER_OPENAI_AUTH_TOKEN="${CONSUMER_OPENAI_AUTH_TOKEN:-$GATEWAY_AUTH_TOKEN}"
CONSUMER_OPENAI_NAME="${CONSUMER_OPENAI_NAME:-openai-consumer}"

WORKER_PORT="${WORKER_PORT:-8789}"

gateway_pid=""
consumer_openai_pid=""
worker_pid=""

shutdown() {
	trap - TERM INT
	for pid in "$gateway_pid" "$consumer_openai_pid" "$worker_pid"; do
		[ -n "$pid" ] && kill "$pid" 2>/dev/null || true
	done
	wait 2>/dev/null || true
	exit 0
}
trap shutdown TERM INT

node packages/gateway/dist/cli.js \
	--port "$GATEWAY_PORT" \
	--auth-token "$GATEWAY_AUTH_TOKEN" \
	--state-file "$GATEWAY_STATE_FILE" &
gateway_pid=$!

echo "Waiting for the gateway to accept connections on port $GATEWAY_PORT..."
attempt=0
until node -e "fetch('http://127.0.0.1:${GATEWAY_PORT}/health').then(() => process.exit(0)).catch(() => process.exit(1))"; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 60 ]; then
		echo "The gateway did not become ready in time" >&2
		shutdown
	fi
	if ! kill -0 "$gateway_pid" 2>/dev/null; then
		echo "The gateway exited before it became ready" >&2
		shutdown
	fi
	sleep 1
done
echo "The gateway is ready"

consumer_openai_args=(--port "$CONSUMER_OPENAI_PORT" --gateway-url "$GATEWAY_WS_URL" --auth-token "$CONSUMER_OPENAI_AUTH_TOKEN" --name "$CONSUMER_OPENAI_NAME")
if [ -n "${CONSUMER_OPENAI_API_KEY:-}" ]; then
	consumer_openai_args+=(--api-key "$CONSUMER_OPENAI_API_KEY")
fi
node packages/consumer_openai/dist/cli.js "${consumer_openai_args[@]}" &
consumer_openai_pid=$!

node packages/docker_server/src/static_server.mjs packages/worker_webpage/dist "$WORKER_PORT" &
worker_pid=$!

set +e
wait -n "$gateway_pid" "$consumer_openai_pid" "$worker_pid"
exit_code=$?
set -e
echo "One of the servers exited (code $exit_code); shutting down the rest" >&2
shutdown
