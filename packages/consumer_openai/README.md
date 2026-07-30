# `@webai/consumer-openai`

An OpenAI-compatible server in front of the Web AI at Home cluster.

It accepts chat completion requests in the shape the OpenAI completion interface uses, turns each request into one cluster task, submits it to the central gateway as a consumer, and answers with the generated text. A program that already talks to OpenAI can therefore use the cluster by changing one setting, its base address.

It is a consumer of the cluster in exactly the same sense as [`@webai/consumer-cli`](../consumer_cli), and it reuses that package's `ConsumerClient` to speak the consumer side of the gateway protocol. It is the work described by [issue #34](https://github.com/webai-at-home/webai-at-home/issues/34).

## Run

`@webai/consumer-cli` and `@webai/protocol` are used through their built output, so they have to be built before this server runs:

```sh
npm run build --workspace @webai/protocol && npm run build --workspace @webai/consumer-cli
```

Then, with the central gateway running:

```sh
npm run dev --workspace @webai/consumer-openai
```

The server listens on port 8788, and an OpenAI client is pointed at `http://localhost:8788/v1`.

## Command line options

| Option | Default | What it does |
| --- | --- | --- |
| `-p, --port <number>` | `8788` | The port to serve OpenAI-compatible requests on. |
| `-u, --gateway-url <url>` | `ws://localhost:8787` | The WebSocket address of the central gateway. |
| `-t, --auth-token <token>` | `development-token` | The bearer token the central gateway requires. |
| `-k, --api-key <key>` | none | The key a request must present to this server, sent in an `Authorization` header as `Bearer` followed by the key. Omitted means no key is required. |
| `-n, --name <name>` | `openai-consumer` | The consumer name this server registers under with the central gateway. |
| `--request-timeout-ms <number>` | `600000` | How long one task may run before it is cancelled and the request is given up on. |
| `--connection-wait-ms <number>` | `5000` | How long a request waits for a registered gateway connection before it is refused. |
| `--max-tasks-in-flight <number>` | `20` | How many cluster tasks to have in flight at once. The gateway's own `--max-tasks-per-principal` defaults to the same number. |

## Endpoints

- `POST /v1/chat/completions` — runs one cluster task and answers with the generated text.
- `GET /v1/models` — lists the models the cluster offers.
- `GET /health` — reports whether this server holds a registered connection to the central gateway and how many requests are waiting for a task. It answers 200 when the connection is up and 503 when it is not, and it requires no key.

The web server is Express, which is what [issue #70](https://github.com/webai-at-home/webai-at-home/issues/70) asks of every web-serving package in this repository.

## The models it offers

A model identifier is the cluster's task type name without the leading `task_type_`, which is the same spelling the `-t/--type` option of `@webai/consumer-cli` accepts. The list comes from `taskTypeNames` in that package, so the models offered here cannot drift away from the task types the cluster runs.

| Model | What runs it | What it needs |
| --- | --- | --- |
| `dev_formula` | The cluster's development formula task: one stage multiplies the number by two, the next adds seven. | One worker browser tab. No model download. Its message must be a number, and its answer is the resulting number written out. |
| `llm_qwen3_0_6b_sharded` | The Qwen3-0.6B model split into three shards, one per worker browser tab. | Worker browser tabs offering all three shard stages, and the shard files generated first. |
| `llm_gemma_nano_chrome_full` | The Gemma Nano language model built into the Chrome browser. | One worker browser tab in a recent Chrome whose own language model is ready. |

[`docs/tasks-and-stages.md`](../../docs/tasks-and-stages.md) describes each of these tasks in full, and [`docs/naming-scheme.md`](../../docs/naming-scheme.md) is the authoritative account of how the names are built.

## Try it

The examples in [`examples/`](./examples) use the official `openai` package on npm against this server, each one runnable on its own. Start with the development formula example, which needs no model download:

```sh
npm run example:chat_completion_dev_formula --workspace @webai/consumer-openai
```

The others are `example:list_models`, `example:chat_completion_system_message`, `example:chat_completion_streaming_refused`, `example:chat_completion_llm_gemma_nano_chrome_full`, and `example:chat_completion_llm_qwen3_0_6b_sharded`. Each file says at the top what the cluster has to have running for it to work. Every example reads `WEBAI_OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment when they are set.

Without the `openai` package, the same two endpoints with `curl`:

```sh
curl http://localhost:8788/v1/models
```

```sh
curl http://localhost:8788/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"dev_formula","messages":[{"role":"user","content":"5"}]}'
```

## How a conversation becomes a prompt

A task in this cluster carries one piece of text, so a conversation of several messages has to become one piece of text before it can be submitted. Two rules do that:

- A request carrying one message sends that message's content unchanged, so the worker browser tab receives exactly what the caller wrote. This is also what makes `dev_formula` usable, because that task type accepts a number and nothing else.
- A request carrying several messages sends them labelled with their roles, one message per line, followed by a final `assistant:` line that invites the answer.

## What this server deliberately does not do

This is a first version. It serves the two endpoints above rather than the whole OpenAI completion interface, and the following are left out on purpose rather than by oversight:

- **It does not stream an answer.** A request that asks for streaming is refused with HTTP 400 naming the `stream` field. The reason is in the cluster: the central gateway sends a consumer a slim revision of a task as the task advances, and that revision carries no partial output text, because sending the whole task on every revision would make the bytes on the connection grow with the square of the number of tokens generated. Streaming therefore needs the gateway to report the text generated so far, which is a change to `@webai/protocol` and the gateway and is follow-up work.
- **It reports no `usage` field.** The gateway reports no token counts to a consumer, so this server has none to report and states none rather than inventing them.
- **It ignores every generation setting.** `temperature`, `top_p`, `max_tokens`, `n`, `stop`, `tools`, `logprobs`, and the rest are accepted in the body and then ignored, because the cluster's task input carries only a prompt. The generation limits are the worker browser tab's own: 160 tokens for the sharded Qwen3-0.6B task, and 400 pieces of an answer for the Chrome built-in task.
- **It refuses a message whose content is a list of parts**, which is what a request carrying an image or audio sends, rather than joining the parts together. It also refuses the `tool` role, because it ignores the tool settings of a request and so could not continue a conversation containing the answer of a tool.
- **It keeps no conversation state.** One request is one cluster task, and the whole conversation is sent with every request.

## How failures are answered

Every failure is answered with the OpenAI error shape, `{ "error": { "message", "type", "param", "code" } }`, so the official `openai` package raises the error it would raise against OpenAI itself.

| What happened | Status | `code` |
| --- | --- | --- |
| The body is not valid JSON, a field is missing, or a message's content is not a single piece of text | 400 | none |
| The request asks for the answer to be streamed | 400 | `streaming_not_supported` |
| The chosen model cannot take the text of the request, such as text that is not a number for `dev_formula` | 400 | none |
| A key is required and the request did not present it | 401 | `invalid_api_key` |
| The request names a model this server does not offer | 404 | `model_not_found` |
| This server already has as many tasks in flight as it holds at once | 429 | `too_many_tasks_in_flight` |
| The central gateway refused the submission because this server has reached its own task limit | 429 | `gateway_rate_limited` |
| The cluster ran the task and the task failed | 502 | `task_failed` |
| The task completed but its result carried no text | 502 | `answer_unreadable` |
| No volunteer browser offered the work before the gateway's submission deadline | 503 | `no_volunteer_available` |
| This server is not connected to the central gateway, or the connection was lost while the request was waiting | 503 | `gateway_unavailable` |
| The task did not finish within `--request-timeout-ms`, and was cancelled | 504 | `request_timed_out` |
| This server failed in a way it does not account for | 500 | `internal_error` |

Two of these are worth spelling out:

- A task already under way is **not** picked up again after the gateway connection returns. The gateway gives the new connection a new device identifier, and a task belongs to the device that submitted it, so a request waiting when the connection drops is given up on rather than being left to wait for an answer that can no longer reach it.
- When a caller hangs up, or `--request-timeout-ms` is reached, this server cancels the task, so the cluster stops running stages for an answer nobody will read.

## Build, type check, and test

```sh
npm run build --workspace @webai/consumer-openai
```

```sh
npm run typecheck --workspace @webai/consumer-openai
```

```sh
npm run test --workspace @webai/consumer-openai
```

The tests cover reading a request, the models on offer, the failure mapping, and the whole run of a cluster task against a stand-in connection, in the way [`packages/consumer_cli/tests/index.test.ts`](../consumer_cli/tests/index.test.ts) tests `ConsumerClient`. They start no server and reach no gateway, so a live run against the real cluster is still what proves the package works; the examples above are that run.

## The source files

- [`src/cli.ts`](./src/cli.ts) — builds every part and starts serving.
- [`src/libs/server_settings.ts`](./src/libs/server_settings.ts) — the command line options, read once and typed.
- [`src/libs/openai_routes.ts`](./src/libs/openai_routes.ts) — the endpoints, including reading and checking a request.
- [`src/libs/cluster_task_runner.ts`](./src/libs/cluster_task_runner.ts) — the one gateway connection, and one promise per submitted task.
- [`src/libs/model_catalog.ts`](./src/libs/model_catalog.ts) — the models on offer, and the task type behind each one.
- [`src/libs/prompt_flattener.ts`](./src/libs/prompt_flattener.ts) — turning a conversation into the single piece of text a task carries.
- [`src/libs/openai_error.ts`](./src/libs/openai_error.ts) — every way a request can fail, with its status and its body.
- [`src/libs/openai_types.ts`](./src/libs/openai_types.ts) — the request bodies accepted and the response bodies returned.
