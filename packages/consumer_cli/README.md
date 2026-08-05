# `@webai/consumer-cli`

Command-line client for the central gateway: submitting tasks, reading the worker cluster's current state, and estimating its capacity.

The program has four subcommands about tasks and the cluster: `submit` sends one task and shows its updates until it completes or fails, `status` reports the connected workers and their free capacity, `capacity` estimates how many concurrent runs of a task type the cluster can currently support, and `log_stats` measures one already recorded `.log_entry.jsonl` message log file.

It has five further subcommands about this participant's own account in the accounting system of [issue #122](https://github.com/webai-at-home/webai-at-home/issues/122): `account_key` generates the key pair that is the account, `account_register` tells the central gateway about it, and `account_information`, `account_balance`, and `account_history` read back what the gateway holds for it. Each of them is documented in [issue #131](https://github.com/webai-at-home/webai-at-home/issues/131), along with the rest of the accounting documentation; `npx consumer_cli help <subcommand>` describes each one in the meantime.

## Run with `npx`

Once this package has been built (`npm run build --workspace @webai/consumer-cli`), its `consumer_cli` binary is linked into the repository's own `node_modules/.bin`, so `npx` runs it from anywhere inside the project without the `npm run dev --workspace ... --` prefix the examples below use:

```sh
npx consumer_cli status
npx consumer_cli submit 5
npx consumer_cli capacity --task_type dev_formula
```

If the `npx consumer_cli` command is not found, run `npm install` from the repository root once, so npm links the `bin` entry declared in this package's `package.json`.

## Shared options

Every subcommand accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `-u, --url <url>` | `ws://localhost:8787` | Gateway WebSocket address. |
| `-a, --auth-token <token>` | `WEBAI_AUTH_TOKEN` environment variable, then `development-token` | Bearer token for the central gateway. |

## `submit`

From the repository root, with the central gateway running:

```sh
npm run dev --workspace @webai/consumer-cli -- submit 5
```

Set the registered consumer name with `--consumer_name`, for example:

```sh
npm run dev --workspace @webai/consumer-cli -- submit --consumer_name dev-formula-consumer 5
```

Use `--url` to connect to another WebSocket endpoint:

```sh
npm run dev --workspace @webai/consumer-cli -- submit 5 --url ws://localhost:9000
```

`submit`'s own options:

| Option | Default | Meaning |
| --- | --- | --- |
| `-t, --task_type <type>` | `dev_formula` | `dev_formula`, `llm_qwen3_0_6b_sharded`, `llm_gemma_nano_chrome_full`, or `llm_qwen3_5_0_8b_full`. |
| `-n, --consumer_name <name>` | `consumer` | Name registered with the gateway. |
| `-s, --stream` | off | Ask a language-model task to return answer pieces while it runs. |

Use `-t/--task_type` to choose the task type:

- `dev_formula` (default) takes a number.
- `llm_qwen3_0_6b_sharded` takes free text, and is run by three worker browser tabs, each holding one shard of the Qwen3-0.6B model.
- `llm_gemma_nano_chrome_full` takes free text, and is run by one worker browser tab using the Gemma Nano model built into Chrome.
- `llm_qwen3_5_0_8b_full` takes free text, and is run by one worker browser tab that downloads and holds the complete Qwen3.5-0.8B model.

```sh
npm run dev --workspace @webai/consumer-cli -- submit "hello there" --task_type llm_qwen3_0_6b_sharded
```

Use `-s/--stream` to ask for the answer in pieces as it is produced, rather than in one result once it is finished. Without it, the cluster answers with the fewest messages the pipeline can manage.

```sh
npm run dev --workspace @webai/consumer-cli -- submit "hello there" --task_type llm_gemma_nano_chrome_full --stream
```

`--stream` is not valid for `dev_formula`, which always returns one numeric
result. `submit` writes gateway messages to `packages/consumer_cli/logs`.

## `status`

Connects as an observer and prints the current worker cluster state: how many workers are connected, how much of their advertised capacity is free, and one row per worker.

```sh
npm run dev --workspace @webai/consumer-cli -- status
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--watch` | off | Keep the connection open and reprint on every change, until interrupted or disconnected. |
| `--json` | off | Print the snapshot as JSON instead of a table. |
| `--timeout <ms>` | `10000` | How long to wait for the central gateway to answer. |

Without `--watch`, `status` prints one snapshot and exits `0`. With `--watch`, it keeps reprinting until interrupted with Ctrl-C (clean exit `0`) or disconnected (non-zero exit); it does not reconnect on its own.

## `capacity`

Estimates how many concurrent runs of a task type the cluster can currently support, from the connected workers and the pipeline that serves that task type.

```sh
npm run dev --workspace @webai/consumer-cli -- capacity --task_type llm_qwen3_0_6b_sharded
```

```
llm_qwen3_0_6b_sharded: 5 concurrent runs supported
  limited by: worker coverage (5 of 8 workers advertise all 3 stages)
```

A pipeline whose every stage keeps state on one worker between rounds — such as a language-model shard's key-value cache — needs a worker that advertises every one of its stages, so capacity is the total free capacity of those workers. A pipeline with no such stage can spread its stages across different workers, so its capacity is set by whichever stage has the least free capacity behind it.

| Option | Default | Meaning |
| --- | --- | --- |
| `--task_type <type>` | — | `dev_formula`, `llm_qwen3_0_6b_sharded`, `llm_gemma_nano_chrome_full`, `llm_qwen3_5_0_8b_full`, or `llm_llama3_2_3b_full`. |
| `--json` | off | Print the estimate as JSON instead of a sentence. |
| `--timeout <ms>` | `10000` | How long to wait for the central gateway to answer. |

An unknown task type is an error with a non-zero exit code. `--task_type` is required.

## `log_stats`

Reads one message log file — a `.log_entry.jsonl` file written by `MessageLogger` (see `@webai/protocol/message_logger`), for example one of the gateway's own `packages/gateway/logs/gateway-*.log_entry.jsonl` files — and prints everything it measures: how much traffic it carried, who carried it, how long every reply and every task and every stage run took, and anything about the file worth a second look. It never connects to the central gateway, so it measures a capture from weeks ago exactly the same way as one from a moment ago.

```sh
npm run dev --workspace @webai/consumer-cli -- log_stats ../gateway/logs/gateway-2026-08-02T03-09-46-028Z.log_entry.jsonl
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-f, --format <format>` | `text` | `text` (a human-readable report), `markdown` (the same report as pipe tables, for pasting into an issue or a notes file), or `json` (the full report as one JSON object). |
| `--top <count>` | `12` | How many rows of each table to print before the rest are only counted. |

A gateway log sees both the consumer and the worker side of every task, so it is the only log that can measure stage runs and worker compute time; a consumer's own log cannot see those, and reports "nothing measured" for them instead of guessing.

## Exit codes

`status` and `capacity` use these exit codes:

- `0` — success.
- `1` — connection failure (unreachable gateway, or dropped mid-`--watch`).
- `2` — authentication failure.
- `3` — timed out waiting for the central gateway to answer.
- `4` — the central gateway sent something this client could not make sense of.

## Public exports

`@webai/consumer_openai` and any other package that reuses this one's consumer functionality import from `@webai/consumer-cli` itself:

```ts
import { ConsumerClient, type ConsumerClientCallbacks, type TaskSocket, TaskInputFactory, type TaskTypeName, taskTypeNames } from '@webai/consumer-cli';
```

- `ConsumerClient` — holds one connection to the central gateway: registers, submits a task, and reports every update through `ConsumerClientCallbacks`.
- `TaskSocket` — the part of a WebSocket connection `ConsumerClient` uses, so it works with both the `ws` package and a browser page's own connection.
- `ConsumerClientCallbacks` — the functions `ConsumerClient` calls as a task's conversation with the gateway proceeds.
- `TaskInputFactory` — turns command line or request text into the `TaskInput` the gateway expects, and checks whether a given string names a task type at all.
- `TaskTypeName` and `taskTypeNames` — every task type a consumer may submit, named without the leading `task_type_`.

This is the only supported entry point; `./libs/consumer_client` and `./libs/task_input_factory` are implementation files under `src/` rather than published subpaths. `Cli`, in `src/cli.ts`, is this package's own command line program rather than a reusable symbol, and is not exported either.

## Build

```sh
npm run build --workspace @webai/consumer-cli
```

For local checks, also run:

```sh
npm run typecheck --workspace @webai/consumer-cli
npm run test --workspace @webai/consumer-cli
```
