# Directory Context: `/packages/consumer_openai`

## Purpose

An OpenAI-compatible server in front of the `webai-at-home` cluster. It accepts a chat completion request in the shape the OpenAI completion interface uses, turns it into one cluster task, submits that task to the central gateway as a consumer, and answers with the generated text, streamed or whole. A program that already talks to OpenAI can use the cluster by changing its base address only.

## Key Exports & Entry Points

- `src/cli.ts`: the `consumer_openai` command line program, with one subcommand, `server`, implemented in `src/commands/server_command.ts`.
- `src/http/openai_routes.ts`: the HTTP routes, `/v1/models` and `/v1/chat/completions`. `src/http/curl_style_transaction_logger.ts` records each request and answer.
- `src/api/`: `openai_types.ts`, `openai_error.ts`, `model_catalog.ts` (which task type each model name maps to), `conversation_builder.ts`, and `prompt_flattener.ts`.
- `src/libs/cluster_task_runner.ts`: submits the task and follows it, on top of `ConsumerClient` from `@webai/consumer-cli`.
- `src/libs/server_settings.ts`: every command line option and environment variable this server reads.
- `examples/`: one runnable example per task type and per calling style, named `chat_completion_<style>_<task type>.ts`.
- `scripts/benchmark_openai_api.ts`: a standalone latency benchmark, not a subcommand of `consumer_openai`.

## Local Rules & Boundaries

- This package is a consumer of the cluster in the same sense as `@webai/consumer-cli`, and it reuses that package's `ConsumerClient` rather than speaking the gateway protocol itself.
- One deployment of this server is one account: the account charged is the server's own, read from `default.account_key.json` in its `--config_dir`, because nothing in an OpenAI-compatible HTTP request carries an account identifier. Do not run it in a publicly reachable container.
- The model names this server answers with are task type names from [`docs/naming_scheme.md`](../../docs/naming_scheme.md), declared in `src/api/model_catalog.ts`.
- `tests/index.test.ts` runs without a cluster. The `tests/real_*.test.ts` files drive real browser tabs with Puppeteer and are run one at a time with the matching `test:real:<task type>` script, never as part of `npm test`.
- Every new command line option or environment variable is added to `src/libs/server_settings.ts` and documented in [`docs/environment_variables.md`](../../docs/environment_variables.md).
