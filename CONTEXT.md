# Directory Context: `/`

## Purpose

`webai-at-home` is the repository root of a npm workspaces monorepo that explores whether idle web browsers can work together to run a large language model that is too large for any one volunteer device. A gateway coordinates a queue of batch tasks, splits each task into a pipeline of stages, and gives every stage to a connected browser tab.

## Key Exports & Entry Points

- `package.json`: the npm workspaces root. `npm run build` builds `@webai/protocol`, `@webai/gateway`, `@webai/consumer-cli`, and `@webai/consumer-openai`, in that order. `npm test` runs the documentation link test and then the tests of every workspace.
- [`packages/protocol`](packages/protocol/): shared message, task type, and pipeline definitions with Zod validation. Every other package depends on this one.
- [`packages/gateway`](packages/gateway/): the coordinator HTTP and WebSocket gateway, the scheduling, and the home page.
- [`packages/worker_webpage`](packages/worker_webpage/): the browser page that connects a worker browser tab to the gateway.
- [`packages/consumer_cli`](packages/consumer_cli/) and [`packages/consumer_openai`](packages/consumer_openai/): the two ways to submit a task, a command-line client and an OpenAI-compatible server.
- [`packages/worker_openai`](packages/worker_openai/): a worker that forwards a prompt to a local server that speaks the OpenAI-compatible API.
- [`packages/docker_server`](packages/docker_server/): the Linux Docker image that runs the gateway and serves the built worker browser page.
- [`packages/flow_viewer`](packages/flow_viewer/): the flow viewer for inspecting recorded message traffic.
- [`packages/_onnx_experiments`](packages/_onnx_experiments/), [`packages/_account_key_experiments`](packages/_account_key_experiments/), [`packages/_idle_experiments`](packages/_idle_experiments/), [`packages/_tiny_iris_classifier`](packages/_tiny_iris_classifier/): browser experiments, kept apart from the working system by the leading underscore.
- [`tests/documentation_links.test.ts`](tests/documentation_links.test.ts): checks that every link in the Markdown documentation resolves.

## Local Rules & Boundaries

- Every task, task type, pipeline, stage, and computation name must follow [`docs/naming_scheme.md`](docs/naming_scheme.md). That document is the one authoritative place for those names, and a new name is added there at the same time it is added to the code.
- Never abbreviate a name. Write `packages/worker_webpage`, `@webai/worker-webpage`, and `task_type_llm_qwen3_0_6b_sharded` in full, every time, in source code, comments, commit messages, issues, and pull requests alike.
- The agent instructions for this repository live in [`AGENTS.md`](AGENTS.md). Read that file as well as this one.
- Package folder names are `snake_case` with a leading underscore for experiments; the npm package name of the same package is `@webai/` followed by the same words in `kebab-case`.
- A message shape that crosses a process boundary belongs in `@webai/protocol` and is validated with Zod there. Do not restate the shape in the gateway, in a consumer, or in a worker.
- A documentation file added under [`docs/`](docs/) must be linked from [`README.md`](README.md) or from another documentation file, because `tests/documentation_links.test.ts` and the README index are how a reader finds it.
- `gateway-accounts.json` and `gateway-ledger.jsonl` at the root are runtime state written by the gateway during development, not source. In the Docker image the gateway writes them under the `/data` volume instead.
