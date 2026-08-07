# Directory Context: `/packages/openai_api_tool`

## Purpose

The command line tool that exercises and measures a server speaking the OpenAI-compatible API, from the outside. It sends chat completion requests to an endpoint, times when the first and the last character of each answer arrived, and reports what answered. It reaches this project's own `consumer_openai` server and any other such server alike, which is how the cluster is compared against a model running on one machine.

## Key Exports & Entry Points

- `src/cli.ts`: the `openai_api_tool` command line program, with three subcommands, implemented in `src/commands/`: `text_completion`, `conversation_history`, and `benchmark`.
- `src/completion_sender.ts`: the one way this package sends a request and times it. `src/completion_types.ts` holds every shared data shape.
- `src/benchmark_runner.ts`: the warm-up and measured requests of one benchmark run, and the aggregation of what they measured.
- `src/model_sweeper.ts`: expands `-m/--model` into the model identifiers to work through. `src/statistics_calculator.ts` and `src/report_renderer.ts` produce the figures and the lines a person reads.
- `src/shared_options.ts`: every command line option all three subcommands accept.

## Local Rules & Boundaries

- The `openai` npm package is the single transport. Never build a request body, parse a server-sent event, or read a response body by hand: one transport is what keeps the three subcommands comparable.
- Every request goes through `CompletionSender`, and every measurement through `BenchmarkRunner`. A subcommand must not talk to an endpoint itself.
- This package holds no server and no gateway protocol. It depends on `@webai/consumer-cli` only for `taskTypeNames` and `taskTypeNamesAcceptingConversation`, so the models the subcommands name cannot drift away from the task types the cluster runs. Do not restate either list here.
- `text_completion` and `conversation_history` reject a model name outside those lists; `benchmark` passes an outside name through unchanged, because it measures endpoints this project has no list of.
- `tests/index.test.ts` runs without a cluster. Its live tests start a local HTTP server rather than reaching a real endpoint, and it imports nothing that needs `@webai/consumer-cli` to have been built.
