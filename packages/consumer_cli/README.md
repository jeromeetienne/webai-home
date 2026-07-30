# `@webai/consumer-cli`

Command-line client for submitting tasks to the central gateway.

It connects over WebSocket, registers as a consumer client, submits one input value, and shows task updates until the task completes or fails.

## Run

From the repository root, with the central gateway running:

```sh
npm run dev --workspace @webai/consumer-cli -- 5

Set the registered consumer name with `--name`, for example:

`npm run dev --workspace @webai/consumer-cli -- --name dev-formula-consumer 5`
```

Use `--url` to connect to another WebSocket endpoint:

```sh
npm run dev --workspace @webai/consumer-cli -- 5 --url ws://localhost:9000
```

Use `-t/--type` to choose the task type:

- `dev_formula` (default) takes a number.
- `llm_qwen3_0_6b_sharded` takes free text, and is run by three worker browser tabs, each holding one shard of the Qwen3-0.6B model.
- `llm_gemma_nano_chrome_full` takes free text, and is run by one worker browser tab using the Gemma Nano model built into Chrome.

```sh
npm run dev --workspace @webai/consumer-cli -- "hello there" --type llm_qwen3_0_6b_sharded
```

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
