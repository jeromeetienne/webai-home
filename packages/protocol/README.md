# `@webai/protocol`

Shared message, task, pipeline, and data definitions for the WebAI distributed
pipeline. Other packages import the public package entry point as
`@webai/protocol`.

## Contents

- `TaskInput`, `Task`, task state, task update, and pipeline definitions.
- `Device` definitions.
- Client-to-gateway and gateway-to-client WebSocket message types, including
  authentication, registration, task submission, assignment, result, retry,
  cancellation, observation, and diagnostics messages.
- Zod validation for task inputs, messages, envelopes, stage payloads, and
  diagnostics batches.
- Public subpath modules for message logging, task projections, envelopes, and
  session renewal.

The current protocol version is `2`; the gateway accepts versions `1` and `2`.
The built-in task types are `task_type_dev_formula`,
`task_type_llm_qwen3_0_6b_sharded`,
`task_type_llm_gemma_nano_chrome_full`, and
`task_type_llm_qwen3_5_0_8b_full`.

## Build

```sh
npm run build --workspace @webai/protocol
```

The compiled JavaScript and type declarations are written to `dist/`.

Run the package checks with:

```sh
npm run typecheck --workspace @webai/protocol
npm run test --workspace @webai/protocol
```
