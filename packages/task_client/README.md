# `@webai/task-client`

Command-line client for submitting numeric tasks to the central server.

The task client connects over WebSocket, registers as an administrator client, submits one input value, prints task updates as JSON, and closes when the task completes or fails.

## Run

From the repository root, with the central server running:

```sh
npm run dev --workspace @webai/task-client -- 5
```

Use `--url` to connect to another WebSocket endpoint:

```sh
npm run dev --workspace @webai/task-client -- 5 --url ws://localhost:9000
```

## Build

```sh
npm run build --workspace @webai/task-client
```
