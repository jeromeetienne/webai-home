# Builds and runs `packages/gateway` and `packages/consumer_openai` together in one Linux
# container. Build from the repository root, because the image needs the whole npm workspace:
#
#   docker build -f packages/docker_server/docker/Dockerfile -t webai-at-home .
#
# See packages/docker_server/README.md for configuration, startup, and shutdown.

###############################################################################
# Build stage — compiles every package this image serves
###############################################################################
FROM node:24-bookworm-slim AS build
WORKDIR /repo

# Only the package manifests are copied first, so this install layer is cached across source
# changes. The root lockfile is not copied: it was resolved on macOS and only carries the
# macOS-specific optional native binaries for tools such as rollup and esbuild (a known npm
# bug, see https://github.com/npm/cli/issues/4828), so `npm ci` against it fails to install the
# matching Linux binaries. A plain `npm install` here resolves fresh against this container's
# own platform instead.
COPY package.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/consumer_cli/package.json packages/consumer_cli/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/consumer_openai/package.json packages/consumer_openai/package.json
COPY packages/worker_webpage/package.json packages/worker_webpage/package.json
RUN npm install

COPY packages/protocol packages/protocol
COPY packages/consumer_cli packages/consumer_cli
COPY packages/gateway packages/gateway
COPY packages/consumer_openai packages/consumer_openai
COPY packages/worker_webpage packages/worker_webpage

# `@webai/consumer-cli` is built because `@webai/consumer_openai` imports its library code
# (`ConsumerClient`, `TaskInputFactory`, `taskTypeNames`) — its own command line program is
# never started in this image. `@webai/worker-webpage` is a browser page built with Vite, served as
# static files by src/static_server.mjs below, not run as a Node program.
RUN npm run build --workspace @webai/protocol \
	&& npm run build --workspace @webai/consumer-cli \
	&& npm run build --workspace @webai/gateway \
	&& npm run build --workspace @webai/consumer-openai \
	&& npm run build --workspace @webai/worker-webpage

# Drops every devDependency (Vite, TypeScript, esbuild, and the rest) the finished build no
# longer needs, so the runtime stage below copies over a `node_modules` this same install
# already has, instead of installing twice.
RUN npm prune --omit=dev

###############################################################################
# Runtime stage — only what the two running servers and the worker page need
###############################################################################
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json ./

COPY --from=build /repo/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /repo/packages/protocol/dist packages/protocol/dist

COPY --from=build /repo/packages/consumer_cli/package.json packages/consumer_cli/package.json
COPY --from=build /repo/packages/consumer_cli/dist packages/consumer_cli/dist

COPY --from=build /repo/packages/gateway/package.json packages/gateway/package.json
COPY --from=build /repo/packages/gateway/dist packages/gateway/dist
COPY --from=build /repo/packages/gateway/web/dist packages/gateway/web/dist

COPY --from=build /repo/packages/consumer_openai/package.json packages/consumer_openai/package.json
COPY --from=build /repo/packages/consumer_openai/dist packages/consumer_openai/dist

COPY --from=build /repo/packages/worker/dist packages/worker/dist

COPY packages/docker_server/src/static_server.mjs packages/docker_server/src/static_server.mjs
COPY packages/docker_server/docker/docker-entrypoint.sh docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

# The gateway's durable task state and every log file are written under here, owned by the
# non-root `node` user the container runs as.
RUN mkdir -p /data packages/gateway/logs packages/consumer_openai/logs \
	&& chown -R node:node /data packages/gateway/logs packages/consumer_openai/logs
USER node

EXPOSE 8787 8788 8789

ENTRYPOINT ["./docker-entrypoint.sh"]
