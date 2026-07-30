# `@webai/consumer-cli`

Command-line and web clients for submitting tasks to the central gateway.

Both interfaces connect over WebSocket, register as consumer clients, submit one input value, and show task updates until the task completes or fails.

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

## Web page

Start the Vite development server:

```sh
npm run web --workspace @webai/consumer-cli
```

Open the displayed address, usually `http://localhost:5173`. Enter the central gateway WebSocket URL, select a task type, and submit an input. The web page can also be built and previewed:

```sh
npm run build --workspace @webai/consumer-cli
npm run preview --workspace @webai/consumer-cli
```

## Build

```sh
npm run build --workspace @webai/consumer-cli
```
