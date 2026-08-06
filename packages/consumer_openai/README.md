# `@webai/consumer-openai`

An OpenAI-compatible server in front of the Web AI at Home cluster.

It accepts chat completion requests in the shape the OpenAI completion interface uses, turns each request into one cluster task, submits it to the central gateway as a consumer, and answers with the generated text. A program that already talks to OpenAI can therefore use the cluster by changing one setting, its base address.

It is a consumer of the cluster in exactly the same sense as [`@webai/consumer-cli`](../consumer_cli), and it reuses that package's `ConsumerClient` to speak the consumer side of the gateway protocol. It is the work described by [issue #34](https://github.com/webai-at-home/webai-at-home/issues/34).

## Run

This package's command line program is `consumer_openai`, with one subcommand: `server` starts
the OpenAI-compatible server. The latency benchmark described below is a separate standalone
script, not a subcommand of `consumer_openai`. Once this package has been built (`npm run build
--workspace @webai/consumer-openai`), the binary is linked into the repository's own
`node_modules/.bin`, so `npx` runs it from anywhere inside the project:

```sh
npx consumer_openai server
```

`@webai/consumer-cli` and `@webai/protocol` are used through their built output, so they have to be built before either subcommand runs:

```sh
npm run build --workspace @webai/protocol && npm run build --workspace @webai/consumer-cli
```

During development, with the central gateway running, `npm run dev` reaches the server without a
build:

```sh
npm run dev --workspace @webai/consumer-openai
```

The server listens on port 8788, and an OpenAI client is pointed at `http://localhost:8788/v1`.

## Benchmarking an OpenAI-compatible endpoint

[`scripts/benchmark_openai_api.ts`](./scripts/benchmark_openai_api.ts) is a small, standalone
OpenAI API benchmark for one endpoint at a time. It imports nothing from the rest of this
package and nothing from any other workspace package, so it needs no build step — only
`commander` and the platform's own `fetch`. It sends the same streamed prompt to the endpoint
repeatedly, one request at a time.

Each request measures five figures, all directly observable from the client side without any
knowledge of the model or its tokenizer, which keeps them comparable across different providers:

| Metric | Brief |
| --- | --- |
| Time to First Character | Elapsed time from sending the request until the first streamed character arrives. Measures perceived responsiveness. |
| Time to Last Character | Elapsed time from sending the request until the final character arrives. Measures end-to-end request latency. |
| Output Characters per Second | The speed at which the endpoint streams the answer after the first character, computed as `outputCharacters / (the Time to Last Character minus the Time to First Character)`. |
| Input Characters | The number of characters sent in the request prompt. |
| Output Characters | The number of characters generated in the response. |

An endpoint that ignores the streaming request and answers as one JSON object instead is still
measurable: its first and last character then arrive at the same moment, so the Time to First
Character equals the Time to Last Character.

`-u/--base_url` and `-m/--model_name` are required, with no default — every run names its own
endpoint and model explicitly:

```sh
npm run benchmark --workspace @webai/consumer-openai -- --base_url http://localhost:1234/v1 --model_name llama-3.2-3b-instruct
```

Convenience scripts run it against the endpoints this project most often benchmarks — LM
Studio directly, and this `consumer_openai` server backed by webai-at-home for two of its
models — start LM Studio, the webai-at-home gateway, the `consumer_openai` server, and the
worker processes each model needs first:

```sh
npm run benchmark:lm_studio:llama-3.2-3b-instruct --workspace @webai/consumer-openai
npm run benchmark:webai_at_home:llm_llama3_2_3b_full --workspace @webai/consumer-openai
npm run benchmark:webai_at_home:llm_qwen3_0_6b_sharded --workspace @webai/consumer-openai
```

Use `-f/--format` to choose the output format: `text` (default), `markdown` (pipe tables, for
pasting into an issue or a notes file), or `json` (a machine-readable report):

```sh
npm run benchmark --workspace @webai/consumer-openai -- --base_url http://localhost:1234/v1 --model_name llama-3.2-3b-instruct --runs 10 --format json
```

The report measures wall-clock latency and response size for that one endpoint; it does not
calculate a monetary price because these OpenAI-compatible endpoints do not provide token
pricing or usage data. To compare two endpoints, run the script once against each and read the
two reports side by side.

## Command line options

| Option | Default | What it does |
| --- | --- | --- |
| `-p, --port <number>` | `8788` | The port to serve OpenAI-compatible requests on. |
| `-u, --gateway-url <url>` | `ws://localhost:8787` | The WebSocket address of the central gateway. |
| `-t, --auth-token <token>` | `development-token` | The bearer token the central gateway requires. |
| `-k, --api-key <key>` | none | The key a request must present to this server, sent in an `Authorization` header as `Bearer` followed by the key. Omitted means no key is required. |
| `-n, --consumer_name <name>` | `consumer_openai server` | The consumer name this server registers under with the central gateway. |
| `--account-key-file <path>` | `data/consumer_openai_config/default.account_key.json` | Where this server's own account key pair is kept, relative to this checkout of the repository, so the stages its tasks run are recorded against that account. One deployment of this server is one account, and it is this server's account rather than the account of whichever program called its OpenAI-compatible endpoint: this server is what the gateway sees. A path with no key pair at it means no account, and the stages are recorded against the shared development account instead. See [`docs/accounting_system.md`](../../docs/accounting_system.md). |
| `--request-timeout-ms <number>` | `600000` | How long one task may run before it is cancelled and the request is given up on. |
| `--connection-wait-ms <number>` | `5000` | How long a request waits for a registered gateway connection before it is refused. |
| `--max-tasks-in-flight <number>` | `20` | How many cluster tasks to have in flight at once. The gateway's own `--max-tasks-per-principal` defaults to the same number. |

## Endpoints

- `POST /v1/chat/completions` — runs one cluster task and answers with the generated text, either in one piece or as the answer is written.
- `GET /v1/models` — lists the models the cluster offers.
- `GET /health` — reports whether this server holds a registered connection to the central gateway and how many requests are waiting for a task. It answers 200 when the connection is up and 503 when it is not, and it requires no key.

The web server is Express, which is what [issue #70](https://github.com/webai-at-home/webai-at-home/issues/70) asks of every web-serving package in this repository.

## The models it offers

A model identifier is the cluster's task type name without the leading `task_type_`, which is the same spelling the `-t/--task_type` option of `@webai/consumer-cli` accepts. The list comes from `taskTypeNames` in that package, so the models offered here cannot drift away from the task types the cluster runs.

| Model | What runs it | What it needs |
| --- | --- | --- |
| `dev_formula` | The cluster's development formula task: one stage multiplies the number by two, the next adds seven. | One worker browser tab. No model download. Its message must be a number, and its answer is the resulting number written out. |
| `llm_qwen3_0_6b_sharded` | The Qwen3-0.6B model split into three shards, one per worker browser tab. | Worker browser tabs offering all three shard stages, and the shard files generated first. |
| `llm_gemma_nano_chrome_full` | The Gemma Nano language model built into the Chrome browser. | One worker browser tab in a recent Chrome whose own language model is ready. |
| `llm_qwen3_5_0_8b_full` | The complete Qwen3.5-0.8B model, downloaded from Hugging Face and held by one worker browser tab. | One worker browser tab with WebGPU and 16-bit float shader support, and enough free storage for the roughly 600 MB download. |
| `llm_llama3_2_3b_full` | The complete Llama 3.2 3B model, held and run by a server on the worker's own device that speaks the OpenAI-compatible API, such as Ollama or LM Studio. | One worker process from `@webai/worker-openai`, and a local server that already has the model. No browser tab, and no download by this project. |

[`docs/tasks_and_stages.md`](../../docs/tasks_and_stages.md) describes each of these tasks in full, and [`docs/naming_scheme.md`](../../docs/naming_scheme.md) is the authoritative account of how the names are built.

## Try it

The examples in [`examples/`](./examples) use the official `openai` package on npm against this server, each one runnable on its own. Start with the development formula example, which needs no model download:

```sh
npm run example:chat_completion_dev_formula --workspace @webai/consumer-openai
```

The others are `example:list_models`, `example:chat_completion_system_message`, `example:chat_completion_nostream_llm_gemma_nano_chrome_full`, `example:chat_completion_streamed_llm_gemma_nano_chrome_full`, `example:chat_completion_nostream_llm_qwen3_0_6b_sharded`, `example:chat_completion_streamed_llm_qwen3_0_6b_sharded`, `example:chat_completion_nostream_llm_qwen3_5_0_8b_full`, `example:chat_completion_streamed_llm_qwen3_5_0_8b_full`, `example:chat_completion_history_llm_qwen3_5_0_8b_full`, `example:chat_completion_nostream_llm_llama3_2_3b_full`, `example:chat_completion_streamed_llm_llama3_2_3b_full`, and `example:chat_completion_history_llm_llama3_2_3b_full`. Each file says at the top what the cluster has to have running for it to work. Every example reads `WEBAI_OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment when they are set.

The two `history` examples are the ones to run to see a real conversation reach a worker: `llm_qwen3_5_0_8b_full` and `llm_llama3_2_3b_full` are the only two models whose task type accepts a whole conversation rather than only one prompt, so each sends a fact in one request and asks for it back in a second request that carries the first request's own answer along with it.

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

## Asking for the answer as it is written

A request that sets `stream: true` is answered as server-sent events: one chunk per piece of the answer, each on its own `data:` line as a `chat.completion.chunk`, ended by a `data: [DONE]` line. The first chunk states the role and carries no text, and the last carries no text and says the answer stopped. Joining the pieces gives the same text the request would have been answered with in one piece.

```sh
curl -N http://localhost:8788/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"llm_gemma_nano_chrome_full","messages":[{"role":"user","content":"What is the capital of France?"}],"stream":true}'
```

Asking for a stream is what makes the cluster send pieces at all. The cluster does not stream internally by default: a task that asked for nothing has its answer produced in as few stage runs as the pipeline can manage, and one that asked for pieces costs a scheduling round for every piece. That is why it is a per-request choice rather than how the cluster always behaves, and it is the work of [issue #77](https://github.com/webai-at-home/webai-at-home/issues/77).

A failure before the first chunk is answered with an HTTP status and an error body, like any other failure. A failure after the first chunk cannot be: the status line has already gone. Such a failure is written into the stream instead, as a `data:` line carrying the same error body, and the stream is then ended.

## What this server deliberately does not do

This is a first version. It serves the two endpoints above rather than the whole OpenAI completion interface, and the following are left out on purpose rather than by oversight:

- **It reports no `usage` field.** The gateway reports no token counts to a consumer, so this server has none to report and states none rather than inventing them.
- **It ignores every generation setting except `stream`.** `temperature`, `top_p`, `max_tokens`, `n`, `stop`, `tools`, `logprobs`, and the rest are accepted in the body and then ignored, because the cluster's task input carries only a prompt and whether the answer is wanted in pieces. The generation limits are the worker browser tab's own: 160 tokens for the sharded Qwen3-0.6B task, and 400 pieces of an answer for the Chrome built-in task.
- **It refuses a message whose content is a list of parts**, which is what a request carrying an image or audio sends, rather than joining the parts together. It also refuses the `tool` role, because it ignores the tool settings of a request and so could not continue a conversation containing the answer of a tool.
- **It keeps no conversation state.** One request is one cluster task, and the whole conversation is sent with every request.

## How failures are answered

Every failure is answered with the OpenAI error shape, `{ "error": { "message", "type", "param", "code" } }`, so the official `openai` package raises the error it would raise against OpenAI itself.

| What happened | Status | `code` |
| --- | --- | --- |
| The body is not valid JSON, a field is missing, or a message's content is not a single piece of text | 400 | none |
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

## Auditing HTTP transactions

Every `POST /v1/chat/completions` request is recorded as one `curl -v`-style block of plain text, appended to its own file, `logs/consumer_openai-<run timestamp>.log_http.txt`, one file per run of this server, in the same `logs/` directory as the message log described above but kept apart from it: that file is this server's own wire protocol with the central gateway, and this one is what a caller of this server actually experienced. This is the work described by [issue #75](https://github.com/webai-at-home/webai-at-home/issues/75).

One block is written per transaction, once its response has closed, in the shape `curl -v`, a browser's network inspector, or a reverse proxy's access log already uses: a `>` line per outgoing request field, a `<` line per incoming response field, a blank line between headers and body, and a few plain diagnostic lines naming how the request was authenticated, how it was submitted to the central gateway, how long it took, and how it ended. It reads like this:

```text
==================================================

> POST /v1/chat/completions HTTP/1.1
> host: localhost:8788
> content-type: application/json
> authorization: Bearer sekret
> content-length: 144
>
> {
>   "model": "llm_qwen3_0_6b_sharded",
>   "messages": [
>     {
>       "role": "user",
>       "content": "What is the capital of France?"
>     }
>   ]
> }

< HTTP/1.1 200 OK
< content-type: application/json
<
< {
<   "id": "chatcmpl-e5f944cd-c863-418a-88e6-3b347a33f9ae",
<   "object": "chat.completion",
<   "created": 1785419970,
<   "model": "llm_qwen3_0_6b_sharded",
<   "choices": [
<     {
<       "index": 0,
<       "message": {
<         "role": "assistant",
<         "content": "The capital of France is **Paris**."
<       },
<       "logprobs": null,
<       "finish_reason": "stop"
<     }
<   ]
< }

Transaction: 7893bfe2-e193-4817-91f8-af59c343cdd4
Duration: 1855 ms
Model: llm_qwen3_0_6b_sharded
Auth: ok
Gateway request: bedf801e-5e65-47a7-a31e-4d1424e4a0d4
Gateway task: task-329d8a1b-eb3d-4d87-baf7-29d739ec3aba
Outcome: completed

==================================================
```

`Gateway request` is the same `taskRequestId` a `task.submit` in the message log above carries, and `Gateway task` is the `taskId` a `task.accepted` in that same file assigns, so a transaction here can be followed into the gateway traffic that answered it. `Outcome` is `completed`, `failed`, or `cancelled`; a request whose caller disconnects before an answer arrives, whether by closing the connection or because `--request-timeout-ms` was reached, prints `< (no response: the caller disconnected before one was sent)` and `Outcome: cancelled`, told apart from a request this server actively refused or failed to serve.

**Nothing is redacted.** Every header is written as received, the `Authorization` header included, and both bodies are written as sent. That is the point of this log: a block says what a caller actually asked for and what it actually received, which is what makes it worth keeping for an audit, and what lets a block be read, compared with `diff`, and replayed as the request it describes.

The only thing held back is length: a body longer than 4096 characters is cut short and followed by `Body truncated (N characters omitted of M)`, so one very long prompt or answer cannot make a whole run's log unreadable.

It follows that this file holds the keys presented to this server and every prompt and answer that went through it, in full. **It is as sensitive as the credentials and the conversations it records**; `logs/` is ignored by git for that reason, and the file should be treated the same way anywhere it is copied.

A failure while writing to this log, including one while first creating the log directory, is caught and reported to this server's own output, so a caller is always given the answer or failure it was owed even when the log itself cannot be written to.

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

The tests cover reading a request, the models on offer, the failure mapping, the whole run of a cluster task against a stand-in connection, and the transaction log described above, in the way [`packages/consumer_cli/tests/index.test.ts`](../consumer_cli/tests/index.test.ts) tests `ConsumerClient`. Most start no server and reach no gateway; a handful send real HTTP requests to the actual Express routes in front of a stand-in gateway connection to check the full request-response flow and what it writes to the transaction log. A live run against the real cluster is still what proves the package works end to end; the examples above are that run.

## The source files

- [`src/cli.ts`](./src/cli.ts) — the `consumer_openai` command line program: dispatches to the `server` subcommand.
- [`src/commands/server_command.ts`](./src/commands/server_command.ts) — the `server` subcommand: builds every part and starts serving.
- [`scripts/benchmark_openai_api.ts`](./scripts/benchmark_openai_api.ts) — the standalone OpenAI API latency benchmark for one endpoint.
- [`src/libs/server_settings.ts`](./src/libs/server_settings.ts) — the `server` subcommand's own command line options, read once and typed.
- [`src/http/openai_routes.ts`](./src/http/openai_routes.ts) — the endpoints, including reading and checking a request.
- [`src/libs/cluster_task_runner.ts`](./src/libs/cluster_task_runner.ts) — the one gateway connection, and one promise per submitted task.
- [`src/api/model_catalog.ts`](./src/api/model_catalog.ts) — the models on offer, and the task type behind each one.
- [`src/api/prompt_flattener.ts`](./src/api/prompt_flattener.ts) — turning a conversation into the single piece of text a task carries.
- [`src/api/openai_error.ts`](./src/api/openai_error.ts) — every way a request can fail, with its status and its body.
- [`src/api/openai_types.ts`](./src/api/openai_types.ts) — the request bodies accepted and the response bodies returned.
- [`src/http/curl_style_transaction_logger.ts`](./src/http/curl_style_transaction_logger.ts) — records every chat completion request to the transaction log described above.
