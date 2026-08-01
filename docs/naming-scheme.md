# Naming scheme for tasks, task types, pipelines, and stages

This document is the one authoritative place that says how a task, a task type, a pipeline, and a stage are named in `webai-at-home`. Every name that exists today follows it, and every new name must follow it as well. The companion document [`tasks-and-stages.md`](./tasks-and-stages.md) describes what each task actually does, and [`protocol-by-role.md`](./protocol-by-role.md) describes the messages these names travel in.

The reason the scheme exists is that a name in this project has to answer three questions on sight: which kind of work is being done, which model is doing it, and how that model is arranged across devices. A name such as `task_type_llm` answered none of them, because the project intends to run more than one language model, and to run some of them split across several devices and some of them whole on one device.

## The structure of a name

Every name is built from the same three parts, in the same order, separated by single underscores:

```text
task_<domain>_<model>_<runtime-or-topology>
task_type_<domain>_<model>_<runtime-or-topology>
<domain>_<model>_<runtime-or-topology>@<version>
stage_<domain>_<model>_<runtime-or-topology>
```

The four lines above are, in order, the name of the task, the name of the task type, the identifier of the pipeline together with its version, and the name of a stage.

The three parts mean the following:

- The **domain** says which kind of work this is. Two domains exist today: `dev` for work that exists to exercise and demonstrate the coordination machinery itself, and `llm` for running a language model.
- The **model** says which model carries the work out, written in lower case with every character that is not a letter or a digit turned into an underscore. The Qwen3-0.6B model is therefore `qwen3_0_6b`, and the Gemma 3n E2B model is `gemma_4_e2b`. A task in the `dev` domain runs no model, so this part is the name of the specific piece of development work instead, for example `formula`.
- The **runtime or topology** says how the model is arranged and where it runs. A model split across several devices is `sharded`. A model held complete on one device is `full`. A model run by a language model built into the browser rather than downloaded by the project names that browser, for example `nano_chrome`.

A stage name carries one extra rule, because a stage is one step rather than a whole task:

- A stage that runs one shard of a sharded model ends in `shard<index>of<count>`, counting from one, for example `shard2of3`.
- A stage that runs a complete, non-sharded model ends in `full`.
- A stage in the `dev` domain ends in the name of the step it performs, for example `multiply` or `add`.

There is a fourth kind of name that is not a task, a task type, a pipeline, or a stage: the **computation**. A computation identifies the code a worker browser runs, while a stage name identifies a step of one pipeline. The two are deliberately separate, so that a pipeline loaded through the gateway's `--pipeline-file` option can introduce a new stage name that reuses code the worker browsers already contain. A computation is named exactly like a stage name with the leading `stage_` removed, and the shard index and count left out, because all shards of one model run the same code: the three shard stages of the Qwen3-0.6B pipeline all name the computation `llm_qwen3_0_6b_shard`.

## The names that exist today

| Task | Task type | Pipeline | Stages | Computations |
| --- | --- | --- | --- | --- |
| `task_dev_formula` | `task_type_dev_formula` | `dev_formula@1` | `stage_dev_formula_multiply` → `stage_dev_formula_add` | `dev_formula_multiply`, `dev_formula_add` |
| `task_llm_qwen3_0_6b_sharded` | `task_type_llm_qwen3_0_6b_sharded` | `llm_qwen3_0_6b_sharded@1` | `stage_llm_qwen3_0_6b_shard1of3` → `stage_llm_qwen3_0_6b_shard2of3` → `stage_llm_qwen3_0_6b_shard3of3` | `llm_qwen3_0_6b_shard` |
| `task_llm_gemma_nano_chrome_full` | `task_type_llm_gemma_nano_chrome_full` | `llm_gemma_nano_chrome_full@1` | `stage_llm_gemma_nano_chrome_full` | `llm_gemma_nano_chrome_full` |

The three shard stages of `llm_qwen3_0_6b_sharded@1` run as a group once per generated token, because that pipeline sets `repeatsUntilDone`. The single stage of `llm_gemma_nano_chrome_full@1` runs once per piece of the answer the browser's own language model produces, for the same reason. The two stages of `dev_formula@1` each run once.

The task type is the value a consumer submits and the value a pipeline specification declares it serves, and it is checked by `TaskType` in [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts). The pipeline identifier and the stage names are declared by `builtinPipelineSpecifications` in [`packages/gateway/src/libs/pipeline_registry.ts`](../packages/gateway/src/libs/pipeline_registry.ts). The task name itself is not an identifier the code stores; it is the name used in conversation and in documentation for the whole task, and it is the task type name with the `_type` part removed.

## Names that are not yet implemented

One further task is planned. Its names are written out here so that the scheme is followed when it is built, and it does not exist in the code today:

| Task | Task type | Pipeline | Stages |
| --- | --- | --- | --- |
| `task_llm_gemma_4_e2b_full` | `task_type_llm_gemma_4_e2b_full` | `llm_gemma_4_e2b_full@1` | `stage_llm_gemma_4_e2b_full` |

It runs a complete model on one device, so it has a single stage that repeats until generation is finished. It is tracked by [issue #60](https://github.com/webai-at-home/webai-at-home/issues/60).

## Names outside the protocol that follow the same words

The scheme is about the identifiers the gateway, the consumers, and the workers exchange, but several surrounding names are kept in step with it so that one task is recognisable everywhere. These are the ones that exist today:

- The task type accepted by the consumer command line option `-t/--type` is the task type name without the leading `task_type_`, so `dev_formula`, `llm_qwen3_0_6b_sharded`, and `llm_gemma_nano_chrome_full`. The three are listed once, in `taskTypeNames` in [`packages/consumer_cli/src/libs/task_input_factory.ts`](../packages/consumer_cli/src/libs/task_input_factory.ts), and [`packages/consumer_cli/src/cli.ts`](../packages/consumer_cli/src/cli.ts) builds both its help text and its check from that list.
- The model identifiers the OpenAI-compatible server offers are the same three names, for the same reason: a model identifier there is the task type name without the leading `task_type_`. `ModelCatalog` in [`packages/consumer_openai/src/libs/model_catalog.ts`](../packages/consumer_openai/src/libs/model_catalog.ts) builds both the list returned by `GET /v1/models` and the check on a request's `model` field from the same `taskTypeNames`, so the models on offer cannot drift away from the task types the cluster runs.
- The sample commands in [`packages/consumer_cli/package.json`](../packages/consumer_cli/package.json) are `sample:dev_formula`, `sample:llm_qwen3_0_6b_sharded`, and `sample:llm_gemma_nano_chrome_full`.
- The consumer names those sample commands register under are the same words with underscores written as hyphens, because they are display names rather than identifiers: `dev-formula-consumer`, `llm-qwen3-0-6b-sharded-consumer`, and `llm-gemma-nano-chrome-full-consumer`.
- The gateway debug pages are served at `/debug_iframe_dev_formula`, `/debug_iframe_llm_qwen3_0_6b_sharded`, and `/debug_iframe_llm_gemma_nano_chrome_full`, and each inline frame in them is named after the single stage it is restricted to, with underscores written as hyphens: `dev-formula-multiply`, `dev-formula-add`, `llm-qwen3-0-6b-shard1of3`, `llm-qwen3-0-6b-shard2of3`, `llm-qwen3-0-6b-shard3of3`, and `llm-gemma-nano-chrome-full`.
- The worker source file that implements the computations of one domain is named after those computations, as `stage_helper_{task_suffix}.ts`: [`packages/worker_webpage/web/src/stages/stage_helper_dev_formula.ts`](../packages/worker_webpage/web/src/stages/stage_helper_dev_formula.ts), [`packages/worker_webpage/web/src/stages/stage_helper_llm_qwen3_0_6b_sharded.ts`](../packages/worker_webpage/web/src/stages/stage_helper_llm_qwen3_0_6b_sharded.ts), and [`packages/worker_webpage/web/src/stages/stage_helper_llm_gemma_nano_chrome_full.ts`](../packages/worker_webpage/web/src/stages/stage_helper_llm_gemma_nano_chrome_full.ts).

## What the shape of a name is checked against

The shared protocol package checks the shape of a stage name and of a computation name, and not the list of names that happen to exist. Both must start with a lower-case letter and contain only lower-case letters, digits, and underscores, and both are limited to 100 characters. Which stage names actually exist is decided at run time by the pipeline specifications the gateway has loaded, and a worker that advertises a stage name no loaded pipeline defines is refused when it registers. The task type, in contrast, is a closed list in `TaskType`, so adding a task type is a change to the shared protocol package.

## The rename that introduced this scheme

The scheme was adopted in one change, described in [issue #62](https://github.com/webai-at-home/webai-at-home/issues/62). The previous names were migrated outright and no compatibility aliases were kept, so nothing in the code answers to `task_type_formula`, `task_type_llm`, `stage_formula_multiply`, `stage_formula_add`, `stage_llm_qwen3_0_6b_shard1on3`, `stage_llm_qwen3_0_6b_shard2on3`, or `stage_llm_qwen3_0_6b_shard3on3` any more. Keeping aliases was rejected because tasks are not persisted across a version change in the prototype, no deployment outside this repository exists, and a pair of names for the same stage would have defeated the purpose of making model identity and topology visible in the name.

Pipeline versioning is unaffected by the rename. A pipeline identifier and its version together select a pipeline specification, and a task records both when it is created, so a task always resolves to the specification it was created against. The renamed pipelines kept version 1, because their identifiers changed at the same time and no task can carry an identifier that no longer exists.
