# Directory Context: `/packages/protocol`

## Purpose

The shared message, task, pipeline, account, and device definitions of `webai-at-home`, with Zod validation. Every shape that crosses a process boundary between the gateway, a consumer, and a worker is defined here once, so the gateway, the consumers, and the workers cannot disagree about it.

## Key Exports & Entry Points

- `src/index.ts`: the public entry point, imported by other packages as `@webai/protocol`. It states what the package offers and holds no definitions of its own. Four further subpaths exist: `@webai/protocol/envelope`, `@webai/protocol/message_logger`, `@webai/protocol/task_projection`, and `@webai/protocol/session_renewal`.
- `src/task/`: `task_types.ts` (`TaskInput`, `GenerationSettings`, `Task`, task state, task snapshot, task update, stage assignment, task events), `pipeline_types.ts` (`StageName`, `PipelineStage`, `PipelineSpecification`), `task_projection.ts`, and `conversation_types.ts`.
- `src/message/`: `client_message.ts`, `gateway_message.ts`, `envelope.ts`, `envelope_types.ts`, `message_logger.ts`, and `diagnostics.ts`.
- `src/accounting/`: `account_types.ts`, `account_identity.ts`, `account_authentication.ts`, `account_key_file.ts`, `account_identity_file.ts`, and `ledger_types.ts`.
- `src/stage/`: `stage_payload_types.ts`, `stage_payload_factory.ts`, and `generated_text.ts`.
- `src/device_types.ts`, `src/identifier.ts`, `src/random_uuid.ts`, and `src/session_renewal.ts`.

## Local Rules & Boundaries

- This package depends on no other package of this repository. Every other package depends on it, so a dependency in the other direction would be a cycle.
- Every definition lives in the file of its own subject. Code inside this package imports from that file directly, never through `src/index.ts`.
- A new definition is added to its subject file first, then re-exported from `src/index.ts` under the section separator of its domain.
- Every shape that travels over the wire is a Zod schema, and the TypeScript type is derived from the schema rather than written twice.
- `TaskType` and the stage names it accepts follow [`docs/naming_scheme.md`](../../docs/naming_scheme.md). Adding a task type here means adding its row to that document as well.
- Run `npm run build --workspace @webai/protocol` before any package that imports it; the other packages' `build:dependencies` script does exactly that.
- `LlmStagePayload.promptTokenCount`, `.completionTokenCount`, and `.stopReason` carry token counts and the worker's own word for why generation stopped, on the result that finishes a language-model task. `stopReason` is not an OpenAI value; translating it into one belongs to whichever consumer speaks the OpenAI Chat Completions interface, not to this package. See milestone 2 of [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
