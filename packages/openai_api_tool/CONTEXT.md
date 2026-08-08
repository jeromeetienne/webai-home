# Directory Context: `/packages/openai_api_tool`

## Purpose

The command line tool that exercises and measures a server speaking the OpenAI-compatible API, from the outside. It sends chat completion requests to an endpoint, times when the first and the last character of each answer arrived, and reports what answered. It reaches this project's own `consumer_openai` server and any other such server alike, which is how the cluster is compared against a model running on one machine.

## Key Exports & Entry Points

- `src/cli.ts`: the `openai_api_tool` command line program, with three subcommands, implemented in `src/commands/`: `completion`, `history`, and `benchmark`.
- `src/completion_sender.ts`: the one way this package sends a request and times it. `src/completion_types.ts` holds every shared data shape.
- `src/benchmark_runner.ts`: the warm-up and measured requests of one benchmark run, and the aggregation of what they measured.
- `src/model_sweeper.ts`: expands `-m/--model` into the model identifiers to work through. `src/statistics_calculator.ts` and `src/report_renderer.ts` produce the figures and the lines a person reads.
- `src/shared_options.ts`: every command line option all three subcommands accept.

## Local Rules & Boundaries

- The `openai` npm package is the single transport. Never build a request body, parse a server-sent event, or read a response body by hand: one transport is what keeps the three subcommands comparable.
- Every request goes through `CompletionSender`, and every measurement through `BenchmarkRunner`. A subcommand must not talk to an endpoint itself.
- This package holds no server and no gateway protocol. It depends on `@webai/consumer-cli` only for `taskTypeNames` and `taskTypeNamesAcceptingConversation`, which supply the model identifiers `all` and `list` name — do not restate either list here.
- `openai_api_tool` is a tool over the OpenAI-compatible chat completion API, not something specific to the Web AI at Home cluster. All three subcommands pass a model name outside `taskTypeNames`/`taskTypeNamesAcceptingConversation` through to the endpoint unchanged, so a name such as `qwen3.5-2b-mlx` on LM Studio works with `completion` and `history`, not only with `benchmark`.
- All three subcommands accept `-f/--format text|markdown|json`. `text`, the default for every subcommand, is the only format `completion`/`history` stream live, colored with `chalk` (green `ok`, yellow `skipped`, red `failed`, turned off automatically once output is piped or redirected); `markdown`/`json` run the sweep silently and print one report once it finishes.
- `tests/index.test.ts` runs without a cluster. Its live tests start a local HTTP server rather than reaching a real endpoint, and it imports nothing that needs `@webai/consumer-cli` to have been built.
