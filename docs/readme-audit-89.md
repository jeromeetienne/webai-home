# README audit for issue #89

Checked on 2026-07-31 against the current source files, package manifests,
Vite inputs, Docker files, scripts, and documentation links.

## Files checked

- [`README.md`](../README.md)
- [`packages/consumer_cli/README.md`](../packages/consumer_cli/README.md)
- [`packages/consumer_openai/README.md`](../packages/consumer_openai/README.md)
- [`packages/docker_server/README.md`](../packages/docker_server/README.md)
- [`packages/flow_viewer/README.md`](../packages/flow_viewer/README.md)
- [`packages/gateway/README.md`](../packages/gateway/README.md)
- [`packages/protocol/README.md`](../packages/protocol/README.md)
- [`packages/worker_webpage/README.md`](../packages/worker_webpage/README.md)
- [`packages/_tiny_iris_classifier/README.md`](../packages/_tiny_iris_classifier/README.md)
- [`packages/_onnx_experiments/README.md`](../packages/_onnx_experiments/README.md)
- [`packages/_onnx_experiments/tools/README.md`](../packages/_onnx_experiments/tools/README.md)

The issue names `packages/worker/README.md`, but the repository contains
`packages/worker_webpage`; the worker README was audited at that actual path.
The `_onnx_experiments` package did not have a README and now has one.

## Coverage checked

- Package names, workspace commands, source entry points, public exports, and
  package scripts.
- Gateway pages, health and diagnostics routes, WebSocket authentication,
  default port, task types, worker parameters, and durable state.
- OpenAI-compatible routes, models, defaults, examples, streaming behaviour,
  limits, errors, and transaction logs.
- Docker image ports, environment variables, volume, startup processes, and
  worker static page.
- Flow viewer input discovery and command-line options.
- Protocol task types, message families, public subpaths, and protocol
  versions.
- Worker page setup, gateway query parameters, model shard source, browser
  cache, and connection lifetime.
- ONNX experiment pages and shard generation and verification commands.
- Iris training, verification, browser copy path, and production build.

## Validation record

The following repository checks are run with the documentation change:

```sh
git diff --check
npm run typecheck --workspace @webai/protocol
npm run typecheck --workspace @webai/consumer-cli
npm run typecheck --workspace @webai/consumer-openai
npm run typecheck --workspace @webai/gateway
npm run typecheck --workspace @webai/flow-viewer
npm run typecheck --workspace @webai/worker-webpage
npm run typecheck --workspace @webai/onnx-experiments
npm run test --workspace @webai/protocol
npm run test --workspace @webai/consumer-cli
npm run test --workspace @webai/consumer-openai
npm run test --workspace @webai/gateway
npm run test --workspace @webai/flow-viewer
npm run build --workspace @webai/gateway
npm run build --workspace @webai/worker-webpage
npm run build --workspace @webai/onnx-experiments
```

The gateway test suite passed when rerun with local socket access. The OpenAI
consumer test suite passed its first 16 tests but then stopped because its
local connection-wait test left a pending promise; this is an existing test
failure rather than a documentation failure. The initial gateway run also
reported `listen EPERM` in the restricted sandbox, which is why the gateway
suite was rerun with socket access.

The Docker commands require a Docker daemon and are not part of the local
Node.js validation list. The Iris training and Qwen3 shard export require
Python dependencies and large model downloads, so their documentation was
checked against the scripts and paths but those downloads are not repeated by
the repository checks above.
