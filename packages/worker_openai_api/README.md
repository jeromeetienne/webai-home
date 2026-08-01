# `@webai/worker-openai-api`

A native worker that runs a model by forwarding its assigned stage to a locally running server
that speaks the OpenAI-compatible Chat Completions API, such as [Ollama](https://ollama.com) or
[LM Studio](https://lmstudio.ai). Unlike `@webai/worker-webpage`, this worker is a Node.js
command line process rather than a browser tab: it never downloads or runs a model itself, and
instead reaches whichever local server, and whichever model that server already has loaded, the
person running it has chosen. See
[issue #100](https://github.com/webai-at-home/webai-at-home/issues/100) and its implementation
plan in [issue #103](https://github.com/webai-at-home/webai-at-home/issues/103).

## Running it

Start Ollama and pull the model first, if it is not already loaded:

```sh
ollama pull llama3.2:3b
```

Then start the worker:

```sh
npm run dev --workspace @webai/worker-openai-api
```

Or, against a built package:

```sh
npm run build --workspace @webai/worker-openai-api
npm run start --workspace @webai/worker-openai-api
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `-u, --url <url>` | `ws://localhost:8787` | The central gateway's WebSocket URL. |
| `-a, --auth-token <token>` | `development-token` | The bearer token the gateway requires. Falls back to the `WEBAI_AUTH_TOKEN` environment variable. |
| `-n, --name <name>` | `openai-api-worker` | The worker name shown in the gateway's device list. |
| `-b, --base-url <url>` | `http://localhost:11434/v1` | The base URL of the local server's OpenAI-compatible API. LM Studio's default is `http://localhost:1234/v1`. |
| `-m, --model <model>` | `llama3.2:3b` | The model the local server is asked for, exactly as that server names it. |
| `-s, --stage-names <name...>` | every stage this worker can run | Restrict this worker to particular stages. |

## How an answer is generated

The worker asks the local server for a streaming chat completion and reads the pieces of the
answer as they arrive. What one stage run does with those pieces follows the `isStreaming`
generation setting the consumer submitted, exactly as the browser-based full-model tasks behave:

- A task that asked for nothing has one run read every piece and return the whole answer, so it
  finishes in a single stage run.
- A task that asked for its answer in pieces has one run read one piece and return it, leaving
  the request to the local server open for the run that follows, plus one final run that finds
  generation finished and returns the whole answer.

## What this worker checks before it registers

Before it advertises `stage_llm_llama3_2_3b_full`, this worker asks the configured base URL for
`GET /v1/models` and checks that the model named by `--model` is in the answer. A worker whose
local server cannot be reached, or does not currently hold that model, registers with no stage
at all rather than accepting work it would fail, and says why in its own output.
