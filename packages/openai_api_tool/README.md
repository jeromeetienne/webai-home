# `@webai/openai-api-tool`

The command line tool that exercises and measures a server speaking the OpenAI-compatible API, from the outside.

It sends chat completion requests to an endpoint, times when the first and the last character of each answer arrived, and reports what answered. It reaches this project's own [`@webai/consumer-openai`](../consumer_openai/) server and any other such server alike — LM Studio and Ollama among them — which is what makes it the way the Web AI at Home cluster is compared against a model running on one machine.

It holds the two programs that used to live inside `@webai/consumer-openai`, as `examples/chat_completion.ts` and `scripts/benchmark_openai_api.ts`. Both sent a chat completion request and timed it, through two separate transports, so the move gave them one shared implementation and one command line program. It is the work described by [issue #147](https://github.com/webai-at-home/webai-at-home/issues/147).

## Run

`@webai/consumer-cli` and `@webai/protocol` are used through their built output, so they have to be built first:

```sh
npm run build:dependencies --workspace @webai/openai-api-tool
```

The three subcommands are then reachable through `tsx`, with no build of this package needed:

```sh
npx tsx ./src/cli.ts completion --model dev_formula --nostream
```

`src/cli.ts` is executable on its own, with the shebang `#!/usr/bin/env -S npx tsx`:

```sh
././src/cli.ts history --model llm_llama3_2_3b_full
```

Once this package has been built (`npm run build --workspace @webai/openai-api-tool`), the binary is linked into the repository's own `node_modules/.bin`:

```sh
npx openai_api_tool completion --model all
```

## The three subcommands

| Subcommand | What it does |
| --- | --- |
| `completion` | Sends one prompt per model and per mode, and reports which ones answered. Every model has its own default prompt: `5` for `dev_formula`, which accepts only a number, and a plain question for every other model. |
| `history` | Sends a two-turn conversation, then checks that the second turn's answer recalls both facts the first turn stated. Only `llm_qwen3_5_0_8b_full` and `llm_llama3_2_3b_full` accept a whole conversation rather than only one prompt, so only those two are swept. |
| `benchmark` | Measures the latency of one endpoint, one model at a time, over repeated requests, and prints a report as text, markdown, or JSON. |

`completion` and `history` print one line per swept pair followed by a summary table, and set the process exit code to `1` when any pair failed, so a single command answers whether the cluster still works.

## Options

Every subcommand accepts these:

| Option | Default | What it does |
| --- | --- | --- |
| `-m, --model <name>` | `all` | One model identifier, a comma-separated list of identifiers, a pattern such as `llm_*`, `all`, or `list` to print the model identifiers and send nothing. |
| `-u, --base_url <url>` | `WEBAI_OPENAI_BASE_URL`, or `http://localhost:8788/v1` | The OpenAI-compatible API to reach, without `/chat/completions`. |
| `-k, --api_key <key>` | `OPENAI_API_KEY`, or `no-key-required` | The bearer token sent to the endpoint. |
| `--timeout_ms <number>` | `600000` | How long one request may take before it is given up on. |
| `-f, --format <format>` | `text` | The output format: `text`, `markdown`, or `json`. |

`completion` and `history` additionally accept `-s/--streamed` or `--nostream` to restrict the run to one mode; giving neither, or both, sweeps both modes. `completion` also accepts `-p/--prompt` to send one prompt instead of each model's own default prompt.

`benchmark` accepts neither mode flag, because it always asks for the answer in pieces: that is what lets it measure the Time to First Character apart from the Time to Last Character. It adds `-p/--prompt` (`Count up to 30`), `-r/--runs` (`10`), and `-w/--warmup_runs` (`1`).

`-f/--format text`, the default for all three subcommands, is the only format `completion` and `history` stream live: the raw answer is written out piece by piece as it arrives, followed by one analysis line per swept pair, colored green for `ok`, yellow for `skipped`, and red for `failed` (using [`chalk`](https://www.npmjs.com/package/chalk), which turns color off automatically once the output is piped or redirected). `-f/--format markdown` or `-f/--format json` runs the sweep silently instead, and prints one report — a markdown table, or JSON holding every outcome and the passed/skipped/failed counts — once every pair has finished:

```sh
npx tsx ./src/cli.ts completion --base_url http://localhost:1234/v1 --model qwen3.5-2b-mlx --format markdown
```

`benchmark` always runs silently and prints its own report in the requested format, since it never streams a raw answer to a person.

`history` shows every message of its two-turn conversation, labeled with its role. In `-f/--format text` each message is printed live as `[user] ...`/`[assistant] ...`; in `-f/--format markdown` a `## Turns` section lists them below the summary table, one subsection per swept model and mode; in `-f/--format json` they appear as the `turns` array on each outcome.

`-m/--model` behaves the same way in all three subcommands: `all` and `list` name the task type names of this project, but a plain name outside that list is passed through to the endpoint unchanged, because `openai_api_tool` is a tool over the OpenAI-compatible chat completion API, not something specific to the Web AI at Home cluster:

```sh
npx tsx ./src/cli.ts benchmark --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct
```

## What the benchmark measures

Each request measures five figures, all directly observable from the client side without any knowledge of the model or its tokenizer, which keeps them comparable across different providers:

| Metric | Brief |
| --- | --- |
| Time to First Character | Elapsed time from sending the request until the first streamed character arrives. Measures perceived responsiveness. |
| Time to Last Character | Elapsed time from sending the request until the final character arrives. Measures end-to-end request latency. |
| Output Characters per Second | The speed at which the endpoint streams the answer after the first character, computed as `outputCharacters / (the Time to Last Character minus the Time to First Character)`. |
| Input Characters | The number of characters sent in the request prompt. |
| Output Characters | The number of characters generated in the response. |

An endpoint that ignores the streaming request and answers as one JSON object instead is still measurable: the `openai` npm package reads such a body as a stream carrying no pieces at all, so `CompletionSender` follows an empty stream with one whole request, and the first and last character then arrive at the same moment.

The report measures wall-clock latency and response size; it calculates no monetary price, because these OpenAI-compatible endpoints provide no token pricing or usage data. To compare two endpoints, run the subcommand once against each and read the two reports side by side.

Convenience scripts run the benchmark against the endpoints this project measures most often — LM Studio directly, and the `consumer_openai` server backed by the cluster for two of its models. Start LM Studio, the gateway, the `consumer_openai` server, and the worker processes each model needs first:

```sh
npm run benchmark:lm_studio:llama-3.2-3b-instruct --workspace @webai/openai-api-tool
```
```sh
npm run benchmark:webai_at_home:llm_llama3_2_3b_full --workspace @webai/openai-api-tool
```
```sh
npm run benchmark:webai_at_home:llm_qwen3_0_6b_sharded --workspace @webai/openai-api-tool
```

## Test it

```sh
npm run test --workspace @webai/openai-api-tool
```

The tests need no cluster and no gateway. The statistics, the model expansion, the aggregation, and the report rendering are checked on their own; the sender is checked against a local HTTP server started by the test, once for a real server-sent event stream whose pieces are spaced out over real wall-clock time, and once for a server that ignores the streaming request and answers with one JSON body.

## The source files

- [`src/cli.ts`](./src/cli.ts) — the `openai_api_tool` command line program: declares the three subcommands and dispatches to them.
- [`src/commands/completion_command.ts`](./src/commands/completion_command.ts) — the `completion` subcommand.
- [`src/commands/history_command.ts`](./src/commands/history_command.ts) — the `history` subcommand.
- [`src/commands/benchmark_command.ts`](./src/commands/benchmark_command.ts) — the `benchmark` subcommand.
- [`src/completion_sender.ts`](./src/completion_sender.ts) — the one way this package sends a request and times it.
- [`src/benchmark_runner.ts`](./src/benchmark_runner.ts) — the warm-up and measured requests of one run, and the aggregation of what they measured.
- [`src/model_sweeper.ts`](./src/model_sweeper.ts) — expands `-m/--model` into the model identifiers to work through.
- [`src/statistics_calculator.ts`](./src/statistics_calculator.ts) — the average, median, minimum, and maximum of measured values.
- [`src/report_renderer.ts`](./src/report_renderer.ts) — the outcome lines, the summary table, and the text, markdown, and JSON reports.
- [`src/shared_options.ts`](./src/shared_options.ts) — every command line option all three subcommands accept.
- [`src/completion_types.ts`](./src/completion_types.ts) — every data shape the three subcommands share.
