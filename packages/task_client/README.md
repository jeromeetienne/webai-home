# `@webai/task-client`

Command-line client for submitting tasks to the central server.

The task client connects over WebSocket, registers as an administrator client, submits one input value, prints task updates as JSON, and closes when the task completes, fails, or is rejected.

## Run

From the repository root, with the central server running:

```sh
npm run dev --workspace @webai/task-client -- 5
```

Use `--url` to connect to another WebSocket endpoint:

```sh
npm run dev --workspace @webai/task-client -- 5 --url ws://localhost:9000
```

Use `-t/--type` to choose the task type — `formula` (default, numeric input) or `llm` (free-text input, not runnable yet):

```sh
npm run dev --workspace @webai/task-client -- "hello there" --type llm
```

## Build

```sh
npm run build --workspace @webai/task-client
```
