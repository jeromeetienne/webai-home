# `@webai/task-client`

Command-line and web clients for submitting tasks to the central server.

Both interfaces connect over WebSocket, register as administrator clients, submit one input value, and show task updates until the task completes or fails.

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

## Web page

Start the Vite development server:

```sh
npm run web --workspace @webai/task-client
```

Open the displayed address, usually `http://localhost:5173`. Enter the central server WebSocket URL, select a task type, and submit an input. The web page can also be built and previewed:

```sh
npm run build --workspace @webai/task-client
npm run preview --workspace @webai/task-client
```

## Build

```sh
npm run build --workspace @webai/task-client
```
