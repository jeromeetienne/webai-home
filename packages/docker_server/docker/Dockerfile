# Builds and runs `packages/gateway` and the built browser page from `packages/worker_webpage` in
# one Linux container. Build from the repository root, because the image needs the whole npm
# workspace:
#
#   docker build -f packages/docker_server/docker/Dockerfile -t webai-at-home .
#
# `packages/consumer_openai` is deliberately not built or shipped here — see the note in
# packages/docker_server/docker/docker-entrypoint.sh and issue #139.
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
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/worker_webpage/package.json packages/worker_webpage/package.json

RUN npm install

COPY packages/protocol packages/protocol
COPY packages/gateway packages/gateway
COPY packages/worker_webpage packages/worker_webpage

# The git commit this image was built from, so a running server can report exactly which
# version it is (see issue #142). `.git` is never copied into this build stage, so the commit
# has to be handed in from outside rather than read with `git rev-parse` here. Coolify can
# supply this build argument itself: enable "Include Source Commit in Build" in the
# application's Advanced settings to have it inject `SOURCE_COMMIT` automatically. Building by
# hand instead needs `--build-arg SOURCE_COMMIT=$(git rev-parse --short HEAD)`.
ARG SOURCE_COMMIT=unknown
ENV COMMIT_SHA=$SOURCE_COMMIT

# `@webai/worker-webpage` is a browser page built with Vite, served as static files by
# src/static_server.mjs below, not run as a Node program.
RUN npm run build --workspace @webai/protocol \
	&& npm run build --workspace @webai/gateway \
	&& npm run build --workspace @webai/worker-webpage

# Drops every devDependency (Vite, TypeScript, esbuild, and the rest) the finished build no
# longer needs, so the runtime stage below copies over a `node_modules` this same install
# already has, instead of installing twice. This reinstalls from the lockfile the first `npm
# install` above wrote, rather than using `npm prune --omit=dev`: with this workspace layout,
# `npm prune` incorrectly deletes some packages nested under a workspace's own `node_modules`
# (e.g. `packages/gateway/node_modules/commander`) even though they are production
# dependencies, leaving the built gateway unable to find `commander` at runtime.
RUN rm -rf node_modules packages/*/node_modules && npm ci --omit=dev

###############################################################################
# Runtime stage — only what the gateway and the worker page need
###############################################################################
FROM node:24-bookworm-slim AS runtime
ARG SOURCE_COMMIT=unknown
ENV NODE_ENV=production
ENV COMMIT_SHA=$SOURCE_COMMIT
WORKDIR /repo

COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json ./

COPY --from=build /repo/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /repo/packages/protocol/dist packages/protocol/dist

# The gateway also gets its own `node_modules`, not just the root one: `commander`'s two
# conflicting version requirements in this workspace (`^12.1.0` here, `^13.0.0` pulled in
# elsewhere as a devDependency) mean npm nests a `commander` copy under this package instead
# of hoisting a single copy to the root `node_modules`.
COPY --from=build /repo/packages/gateway/package.json packages/gateway/package.json
COPY --from=build /repo/packages/gateway/node_modules packages/gateway/node_modules
COPY --from=build /repo/packages/gateway/dist packages/gateway/dist
COPY --from=build /repo/packages/gateway/web/dist packages/gateway/web/dist

COPY --from=build /repo/packages/worker_webpage/dist packages/worker_webpage/dist

COPY packages/docker_server/src/static_server.mjs packages/docker_server/src/static_server.mjs
COPY packages/docker_server/docker/docker-entrypoint.sh docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

# The gateway's durable task state and every log file are written under here, owned by the
# non-root `node` user the container runs as.
RUN mkdir -p /data packages/gateway/logs \
	&& chown -R node:node /data packages/gateway/logs
USER node

EXPOSE 8787 8789

ENTRYPOINT ["./docker-entrypoint.sh"]
