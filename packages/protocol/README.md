# `@webai/protocol`

Shared message and data definitions for the WebAI distributed formula pipeline.

## Contents

- `TaskInput`, `Task`, and task state definitions.
- `Device` definitions.
- Client-to-gateway and gateway-to-client WebSocket message types.
- Zod validation for finite numeric task input.

## Build

```sh
npm run build --workspace @webai/protocol
```

The compiled JavaScript and type declarations are written to `dist/`.
