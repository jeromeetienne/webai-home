# Tasks and stages

This document lists every kind of task the `webai-at-home` cluster can run, what each kind of task does, why it exists, and every stage the cluster has to carry out to finish it. The companion document [`protocol-by-role.md`](./protocol-by-role.md) describes the messages the gateway, the consumers, and the workers exchange while this happens, and [`naming-scheme.md`](./naming-scheme.md) is the authoritative account of how every task, task type, pipeline, and stage name is built.

## How a task turns into stages

A task is submitted by a consumer as a task input: a task type together with one value. The task type is one of exactly two values, checked by `TaskType` in [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts).

When a task is submitted, the gateway picks a pipeline for it. A pipeline is a specification that names the task type it serves and lists the ordered stages that make that task type up. The gateway chooses the highest version among the pipelines that serve the task's type and are not retired, and it copies that pipeline's stage sequence onto the task. The stage sequence is therefore data the task carries, not a sequence built into the gateway. The pipelines the gateway knows without being given a pipeline file are in `builtinPipelineSpecifications` in [`packages/gateway/src/libs/pipeline_registry.ts`](../packages/gateway/src/libs/pipeline_registry.ts), and the `--pipeline-file` command line option can add more.

Two different names are involved in every stage, and they mean different things:

- The **stage name** identifies one step of one pipeline, for example `stage_dev_formula_multiply`. A worker advertises the stage names it is willing to receive, and the gateway refuses a worker that advertises a stage name no loaded pipeline defines.
- The **computation** identifies the code that actually carries the step out, for example `dev_formula_multiply`. Every stage assignment message carries the computation, and a worker decides what to run from the computation and never from the stage name. This is what allows a pipeline added through `--pipeline-file` to introduce a new stage name that reuses a computation the worker browsers already contain, without rebuilding them.

Each stage also states the identifier of the schema its input must match, the identifier of the schema its output must match, and how the value is encoded. Today every stage uses the `inline-json` encoding, which means the value travels inside the message itself rather than through a separate transfer.

A stage may state two optional scheduling settings:

- `leaseMs` is how long the assignment lease for that stage lasts. A stage that does not state one uses the gateway's `--lease-ms` default of 15000 milliseconds. No stage of either built-in pipeline states its own value, so both pipelines use that default. A worker keeps a lease alive while it is still working by sending a stage heartbeat message.
- `prefersSameWorkerOnRetry` makes a retried attempt go back to the device that previously held the stage, instead of deliberately avoiding that device. This matters for a stage that keeps state in memory between assignments.

A pipeline may also state `repeatsUntilDone`. A pipeline that does not state it runs each of its stages exactly once and then the task is complete. A pipeline that does state it runs its stages again from the first once the last stage finishes, and stops only when the last stage returns a result whose `done` field is `true`. The decision is made by `TaskStore.nextStage` in [`packages/gateway/src/libs/task_store.ts`](../packages/gateway/src/libs/task_store.ts).

A task is retried at most `--max-attempts` times per stage, three by default. When no connected worker advertises the stage that comes next, the task is put back into the `queued` state and waits, rather than failing.

## The tasks

### Task type `task_type_dev_formula`

**Name:** `task_type_dev_formula`, served by the pipeline whose identifier is `dev_formula`, at version 1.

**Input:** one finite number.

**What it does:** it multiplies the submitted number by two, then adds seven to the result. Submitting the number 5 produces 5 × 2 = 10 from the first stage and 10 + 7 = 17 from the second stage, so the task result is 17.

**Purpose:** it exercises the whole coordination path — submission, pipeline selection, stage assignment, leases, heartbeats, retries, results, and task updates — using arithmetic so cheap that nothing about the outcome depends on a model download, a graphics processor, or the speed of the volunteer device. It is also the demonstration that two separate devices can cooperate on one task: after a stage finishes, the gateway prefers to hand the next stage of a formula task to a device other than the one that just ran a stage. That preference is not a requirement. If no other suitable device is connected, the same device receives the next stage as well, so a single worker browser tab can complete a formula task on its own.

**Stages the cluster must carry out**, in this order:

| Order | Stage name | Computation | Input schema | Output schema | Encoding | What this stage does |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `stage_dev_formula_multiply` | `dev_formula_multiply` | `number@1` | `number@1` | `inline-json` | Multiplies the incoming number by two and returns the product. |
| 2 | `stage_dev_formula_add` | `dev_formula_add` | `number@1` | `number@1` | `inline-json` | Adds seven to the incoming number and returns the sum. |

Neither stage states its own lease duration, so both use the gateway default. Neither stage sets `prefersSameWorkerOnRetry`, so a retried attempt is deliberately given to a different device when one is available. The pipeline does not set `repeatsUntilDone`, so the two stages run once each and the task then completes with the second stage's value as its result.

**What the cluster needs in order to run it:** at least one connected worker browser tab that implements the computations `dev_formula_multiply` and `dev_formula_add`. Both computations are implemented by `StageDevFormulaHelper` in [`packages/worker/public/src/stage_dev_formula_helper.ts`](../packages/worker/public/src/stage_dev_formula_helper.ts), which every worker browser tab contains. Two tabs, each restricted to one of the two stages, show the two devices cooperating; the page `packages/gateway/public/debug_iframe_dev_formula/index.html` opens exactly that arrangement, one inline frame named `dev-formula-multiply` restricted to `stage_dev_formula_multiply` and one named `dev-formula-add` restricted to `stage_dev_formula_add`.

**How to submit one:**

```bash
npm run sample:dev_formula --workspace @webai/consumer
```

That script submits the number 5 under the consumer name `dev-formula-consumer`. To submit a different number, call the command line client directly:

```bash
npm run dev --workspace @webai/consumer -- --type dev_formula 12
```

### Task type `task_type_llm_qwen3_0_6b_sharded`

**Name:** `task_type_llm_qwen3_0_6b_sharded`, served by the pipeline whose identifier is `llm_qwen3_0_6b_sharded`, at version 1.

**Input:** one text prompt, which must not be empty.

**What it does:** it generates text with the Qwen3-0.6B language model, whose Hugging Face identifier is `onnx-community/Qwen3-0.6B-ONNX`. The model has been split into three consecutive shards, each holding a group of the model's layers, and each shard is run by one stage. The three stages together produce one token of output. Because a full answer needs many tokens, the pipeline sets `repeatsUntilDone` and the gateway therefore runs the three stages again from the first once per generated token, until generation stops.

Generation stops for one of two reasons, both decided by the third stage: the model produced the end-of-sequence token, whose identifier is 151645, or the number of generated tokens reached the safety limit of 160. The limit exists so that a model that never emits the end-of-sequence token cannot generate forever. Both bounds are defined in [`packages/worker/public/src/stage_llm_qwen3_0_6b_helper.ts`](../packages/worker/public/src/stage_llm_qwen3_0_6b_helper.ts).

**Purpose:** this is the task the project exists for. It tests whether a language model too large for one volunteer device can be run by several ordinary browsers, each holding only its own part of the model, with only small hand-off values travelling between them. It is the pipeline-parallel arrangement described in the repository README, running behind the real scheduling path rather than behind a single button on a page.

**Stages the cluster must carry out**, in this order, once per generated token:

| Order | Stage name | Computation | Input schema | Output schema | Encoding | What this stage does |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `stage_llm_qwen3_0_6b_shard1of3` | `llm_qwen3_0_6b_shard` | `llm@1` | `llm@1` | `inline-json` | Runs the first shard of the model. On the first round of a task it turns the submitted prompt into token identifiers itself; on every later round it receives the single token the third stage produced. It returns the two hand-off tensors taken at the boundary after its own layers, together with the token identifiers and the sequence position the next shard needs. |
| 2 | `stage_llm_qwen3_0_6b_shard2of3` | `llm_qwen3_0_6b_shard` | `llm@1` | `llm@1` | `inline-json` | Runs the middle shard of the model, starting from the hand-off tensors the first stage returned, and returns the hand-off tensors taken at the boundary after its own layers. |
| 3 | `stage_llm_qwen3_0_6b_shard3of3` | `llm_qwen3_0_6b_shard` | `llm@1` | `llm@1` | `inline-json` | Runs the last shard of the model, reads the model's output values, and chooses the next token. It returns the text generated so far. When generation should stop it sets `done` to `true`, which ends the task; otherwise it returns the chosen token and its sequence position, and the gateway starts another round at `stage_llm_qwen3_0_6b_shard1of3`. |

All three stages name the same computation, `llm_qwen3_0_6b_shard`, implemented by `StageLlmQwen3_0_6bHelper`. A worker does not tell the three stages apart by name; the gateway sends the position of the stage within its pipeline in each assignment, and the worker uses that position as the shard number. This is why a pipeline may name its shard stages anything, as long as it lists three of them in shard order.

All three stages set `prefersSameWorkerOnRetry`, and the gateway also skips, for a language-model task only, the preference for moving the next stage to a different device that it applies to formula tasks. Both exist for the same reason: each shard keeps two pieces of state in the memory of the device running it, held per task — the key-value cache from that shard's previous round, and, for the third shard, the tokens generated so far. Moving a shard to a different device would throw that state away. Keeping the state in browser memory is also why only the small hand-off tensors travel inside messages, instead of the whole cache being sent over the connection every round.

The hand-off between shards is taken at two fixed points inside the model, named in `SHARD_BOUNDARIES` in the helper. The boundary between the first and second shard is at the input layer normalization of layer 9, and the boundary between the second and third shard is at the input layer normalization of layer 19. At each boundary two tensors are carried across: the normalized values and the residual values. A tensor travels as its dimensions, its element type, and its data encoded as base64 text. That text encoding is a deliberately simple first format for testing and is not intended as the final one.

**What the cluster needs in order to run it:** connected worker browser tabs that between them advertise all three stage names, and that can download and run the model shards. Each tab downloads only the shards for the stages it advertises, and caches them in the browser's IndexedDB storage under the database name `onnxruntime-qwen3-models`, so the download happens once per device rather than once per task. The tokenizer data is fetched from Hugging Face. Running the model uses ONNX Runtime Web.

The three shard files are a setup prerequisite rather than part of the repository. They are large, together about 860 megabytes, and they are excluded from version control, so they have to be generated once by `packages/_onnx_experiments/tools/verify_qwen3_shards.mjs` into the public directory of `packages/_onnx_experiments`. The gateway then serves them from there, on its development server only, so that they are not duplicated into `packages/gateway`. A worker tab that requests a shard before the files have been generated receives a response saying which file was missing.

The normal arrangement is three tabs, each restricted to one stage, which is what the page `packages/gateway/public/debug_iframe_llm_qwen3_0_6b_sharded/index.html` opens: three inline frames named `llm-qwen3-0-6b-shard1of3`, `llm-qwen3-0-6b-shard2of3`, and `llm-qwen3-0-6b-shard3of3`, restricted to `stage_llm_qwen3_0_6b_shard1of3`, `stage_llm_qwen3_0_6b_shard2of3`, and `stage_llm_qwen3_0_6b_shard3of3` respectively. With that arrangement each shard stage always lands on the tab that is the only one advertising it, so each shard's state is on the device that needs it in the following round. A single tab advertising all three stages also completes the task, but then one device downloads and holds all three shards, which is the situation the project is trying to avoid.

**How to submit one:**

```bash
npm run sample:llm_qwen3_0_6b_sharded --workspace @webai/consumer
```

That script submits the prompt "What is the capital of France?" under the consumer name `llm-qwen3-0-6b-sharded-consumer`. To submit a different prompt, call the command line client directly:

```bash
npm run dev --workspace @webai/consumer -- --type llm_qwen3_0_6b_sharded "Write one sentence about rain."
```

## Every stage in the cluster

Five stage names exist across the two built-in pipelines, using three distinct computations.

| Stage name | Pipeline | Task type | Computation |
| --- | --- | --- | --- |
| `stage_dev_formula_multiply` | `dev_formula` version 1 | `task_type_dev_formula` | `dev_formula_multiply` |
| `stage_dev_formula_add` | `dev_formula` version 1 | `task_type_dev_formula` | `dev_formula_add` |
| `stage_llm_qwen3_0_6b_shard1of3` | `llm_qwen3_0_6b_sharded` version 1 | `task_type_llm_qwen3_0_6b_sharded` | `llm_qwen3_0_6b_shard` |
| `stage_llm_qwen3_0_6b_shard2of3` | `llm_qwen3_0_6b_sharded` version 1 | `task_type_llm_qwen3_0_6b_sharded` | `llm_qwen3_0_6b_shard` |
| `stage_llm_qwen3_0_6b_shard3of3` | `llm_qwen3_0_6b_sharded` version 1 | `task_type_llm_qwen3_0_6b_sharded` | `llm_qwen3_0_6b_shard` |

A worker browser tab decides which of these it offers by asking the gateway for its loaded pipelines and keeping every stage whose computation the tab implements. The page address may narrow that set further through its `enabledStages` parameter, which is how the two debug pages give each inline frame a single stage. A tab that names no stages at all offers every stage the loaded pipelines define whose computation it implements. The choice is made by `offeredStages` in [`packages/worker/public/src/main.ts`](../packages/worker/public/src/main.ts).

## The values carried between stages

Every value sent to a stage or returned by one is built by `StagePayloadFactory` in [`packages/protocol/src/stage_payload_factory.ts`](../packages/protocol/src/stage_payload_factory.ts), so the gateway and the worker browsers share one definition of each shape:

- A formula stage carries a plain number, unchanged.
- The first round of a language-model task carries the submitted prompt text to `stage_llm_qwen3_0_6b_shard1of3`.
- A hand-off from one shard to the next within one round carries the boundary tensors, the token identifiers processed in that round, and the position of the first of those tokens within the whole sequence.
- A third-stage result that continues generation carries the text generated so far, the single token just chosen, that token's position, and `done` set to `false`.
- A third-stage result that ends generation carries the complete generated text and `done` set to `true`.

## Where these definitions live

- Task types and task inputs: `TaskType` and `TaskInput` in [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts).
- Pipeline and stage specifications, including the two built-in pipelines: [`packages/gateway/src/libs/pipeline_registry.ts`](../packages/gateway/src/libs/pipeline_registry.ts).
- The rule that decides which stage comes next, including the repeating case: `TaskStore.nextStage` in [`packages/gateway/src/libs/task_store.ts`](../packages/gateway/src/libs/task_store.ts).
- Stage assignment, worker selection, leases, and retries: [`packages/gateway/src/cli.ts`](../packages/gateway/src/cli.ts).
- The formula computations: [`packages/worker/public/src/stage_dev_formula_helper.ts`](../packages/worker/public/src/stage_dev_formula_helper.ts).
- The language-model shard computation: [`packages/worker/public/src/stage_llm_qwen3_0_6b_helper.ts`](../packages/worker/public/src/stage_llm_qwen3_0_6b_helper.ts).
- Submitting a task from the command line: [`packages/consumer/src/cli.ts`](../packages/consumer/src/cli.ts) and [`packages/consumer/src/consumer_client.ts`](../packages/consumer/src/consumer_client.ts).
