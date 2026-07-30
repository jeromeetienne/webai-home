# Tasks and stages

This document lists every kind of task the `webai-at-home` cluster can run, what each kind of task does, why it exists, and every stage the cluster has to carry out to finish it. The companion document [`protocol-by-role.md`](./protocol-by-role.md) describes the messages the gateway, the consumers, and the workers exchange while this happens, and [`naming-scheme.md`](./naming-scheme.md) is the authoritative account of how every task, task type, pipeline, and stage name is built.

## How a task turns into stages

A task is submitted by a consumer as a task input: a task type together with one value. The task type is one of exactly three values, checked by `TaskType` in [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts).

When a task is submitted, the gateway picks a pipeline for it. A pipeline is a specification that names the task type it serves and lists the ordered stages that make that task type up. The gateway chooses the highest version among the pipelines that serve the task's type and are not retired, and it copies that pipeline's stage sequence onto the task. The stage sequence is therefore data the task carries, not a sequence built into the gateway. The pipelines the gateway knows without being given a pipeline file are in `builtinPipelineSpecifications` in [`packages/gateway/src/libs/pipeline_registry.ts`](../packages/gateway/src/libs/pipeline_registry.ts), and the `--pipeline-file` command line option can add more.

Two different names are involved in every stage, and they mean different things:

- The **stage name** identifies one step of one pipeline, for example `stage_dev_formula_multiply`. A worker advertises the stage names it is willing to receive, and the gateway refuses a worker that advertises a stage name no loaded pipeline defines.
- The **computation** identifies the code that actually carries the step out, for example `dev_formula_multiply`. Every stage assignment message carries the computation, and a worker decides what to run from the computation and never from the stage name. This is what allows a pipeline added through `--pipeline-file` to introduce a new stage name that reuses a computation the worker browsers already contain, without rebuilding them.

Each stage also states the identifier of the schema its input must match, the identifier of the schema its output must match, and how the value is encoded. Today every stage uses the `inline-json` encoding, which means the value travels inside the message itself rather than through a separate transfer.

A stage may state two optional scheduling settings:

- `leaseMs` is how long the assignment lease for that stage lasts. A stage that does not state one uses the gateway's `--lease-ms` default of 15000 milliseconds. Only `stage_llm_gemma_nano_chrome_full` states its own value, 60000 milliseconds; every other built-in stage uses the default. A worker keeps a lease alive while it is still working by sending a stage heartbeat message.
- `prefersSameWorkerOnRetry` makes a stage go back to the device that already holds the state that stage keeps in memory, instead of deliberately avoiding that device. It applies to three moments: a retried attempt after a lease expiry, the assignment of the stage that follows a finished one, and the assignment of a stage on a task that had to wait in the `queued` state. A stage that does not set it is instead preferably moved to a device other than the one that just ran a stage of the task.

Which device holds the state a stage needs depends on which stage is about to run, not on which device ran last: in a pipeline that repeats, the device holding the state for the upcoming stage is the device that ran that same stage in the previous round. The gateway therefore records, on the task itself, which device most recently completed each stage of that task, in the field `stageWorkerDeviceIds`. The placement is decided by `WorkerPlacement` in [`packages/gateway/src/libs/worker_placement.ts`](../packages/gateway/src/libs/worker_placement.ts), which reads that record first and falls back to the device that just finished a stage, for the first round of a repeating pipeline and for a stage whose state is handed to it by the stage before it on the same device.

The preferred device is a preference and not a requirement, because the device holding the state may have disconnected, may have stopped offering the stage, or may already be running as many assignments as its own limit allows. In any of those cases the stage is given to another device that advertises it, and a stage that cannot be continued elsewhere fails there and says so.

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

**What the cluster needs in order to run it:** at least one connected worker browser tab that implements the computations `dev_formula_multiply` and `dev_formula_add`. Both computations are implemented by `StageDevFormulaHelper` in [`packages/worker/web/src/stage_dev_formula_helper.ts`](../packages/worker/web/src/stage_dev_formula_helper.ts), which every worker browser tab contains. Two tabs, each restricted to one of the two stages, show the two devices cooperating; the page `packages/gateway/web/debug_iframe_dev_formula/index.html` opens exactly that arrangement, one inline frame named `dev-formula-multiply` restricted to `stage_dev_formula_multiply` and one named `dev-formula-add` restricted to `stage_dev_formula_add`.

**How to submit one:**

```bash
npm run sample:dev_formula --workspace @webai/consumer-cli
```

That script submits the number 5 under the consumer name `dev-formula-consumer`. To submit a different number, call the command line client directly:

```bash
npm run dev --workspace @webai/consumer-cli -- --type dev_formula 12
```

### Task type `task_type_llm_qwen3_0_6b_sharded`

**Name:** `task_type_llm_qwen3_0_6b_sharded`, served by the pipeline whose identifier is `llm_qwen3_0_6b_sharded`, at version 1.

**Input:** one text prompt, which must not be empty.

**What it does:** it generates text with the Qwen3-0.6B language model, whose Hugging Face identifier is `onnx-community/Qwen3-0.6B-ONNX`. The model has been split into three consecutive shards, each holding a group of the model's layers, and each shard is run by one stage. The three stages together produce one token of output. Because a full answer needs many tokens, the pipeline sets `repeatsUntilDone` and the gateway therefore runs the three stages again from the first once per generated token, until generation stops.

Generation stops for one of two reasons, both decided by the third stage: the model produced the end-of-sequence token, whose identifier is 151645, or the number of generated tokens reached the safety limit of 160. The limit exists so that a model that never emits the end-of-sequence token cannot generate forever. Both bounds are defined in [`packages/worker/web/src/stage_llm_qwen3_0_6b_helper.ts`](../packages/worker/web/src/stage_llm_qwen3_0_6b_helper.ts).

**Purpose:** this is the task the project exists for. It tests whether a language model too large for one volunteer device can be run by several ordinary browsers, each holding only its own part of the model, with only small hand-off values travelling between them. It is the pipeline-parallel arrangement described in the repository README, running behind the real scheduling path rather than behind a single button on a page.

**Stages the cluster must carry out**, in this order, once per generated token:

| Order | Stage name | Computation | Input schema | Output schema | Encoding | What this stage does |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `stage_llm_qwen3_0_6b_shard1of3` | `llm_qwen3_0_6b_shard` | `llm@1` | `llm@1` | `inline-json` | Runs the first shard of the model. On the first round of a task it turns the submitted prompt into token identifiers itself; on every later round it receives the single token the third stage produced. It returns the two hand-off tensors taken at the boundary after its own layers, together with the token identifiers and the sequence position the next shard needs. |
| 2 | `stage_llm_qwen3_0_6b_shard2of3` | `llm_qwen3_0_6b_shard` | `llm@1` | `llm@1` | `inline-json` | Runs the middle shard of the model, starting from the hand-off tensors the first stage returned, and returns the hand-off tensors taken at the boundary after its own layers. |
| 3 | `stage_llm_qwen3_0_6b_shard3of3` | `llm_qwen3_0_6b_shard` | `llm@1` | `llm@1` | `inline-json` | Runs the last shard of the model, reads the model's output values, and chooses the next token. It returns the text generated so far. When generation should stop it sets `done` to `true`, which ends the task; otherwise it returns the chosen token and its sequence position, and the gateway starts another round at `stage_llm_qwen3_0_6b_shard1of3`. |

All three stages name the same computation, `llm_qwen3_0_6b_shard`, implemented by `StageLlmQwen3_0_6bHelper`. A worker does not tell the three stages apart by name; the gateway sends the position of the stage within its pipeline in each assignment, and the worker uses that position as the shard number. This is why a pipeline may name its shard stages anything, as long as it lists three of them in shard order.

All three stages set `prefersSameWorkerOnRetry`. Each shard keeps two pieces of state in the memory of the device running it, held per task — the key-value cache from that shard's previous round, and, for the third shard, the tokens generated so far. Moving a shard to a different device would throw that state away. Because the stages set it, a shard is not moved away from the device that just ran a stage, and each round after the first places each shard back on the device that ran that same shard in the previous round, read from the task's `stageWorkerDeviceIds`. Keeping the state in browser memory is also why only the small hand-off tensors travel inside messages, instead of the whole cache being sent over the connection every round.

The hand-off between shards is taken at two fixed points inside the model, named in `SHARD_BOUNDARIES` in the helper. The boundary between the first and second shard is at the input layer normalization of layer 9, and the boundary between the second and third shard is at the input layer normalization of layer 19. At each boundary two tensors are carried across: the normalized values and the residual values. A tensor travels as its dimensions, its element type, and its data encoded as base64 text. That text encoding is a deliberately simple first format for testing and is not intended as the final one.

**What the cluster needs in order to run it:** connected worker browser tabs that between them advertise all three stage names, and that can download and run the model shards. Each tab downloads only the shards for the stages it advertises, and caches them in the browser's IndexedDB storage under the database name `onnxruntime-qwen3-models`, so the download happens once per device rather than once per task. The tokenizer data is fetched from Hugging Face. Running the model uses ONNX Runtime Web.

The three shard files are published in the public Hugging Face model repository [`jerome-etienne/webai-at-home-qwen3-0.6b-shards`](https://huggingface.co/jerome-etienne/webai-at-home-qwen3-0.6b-shards). They are large, together about 860 megabytes, so the Worker downloads only its assigned shard from the immutable Hugging Face revision while the Worker site remains a small static application. The original files remain a setup prerequisite for the local ONNX experiment and can be generated by the tools in `packages/_onnx_experiments/tools/`.

The normal arrangement is three tabs, each restricted to one stage, which is what the page `packages/gateway/web/debug_iframe_llm_qwen3_0_6b_sharded/index.html` opens: three inline frames named `llm-qwen3-0-6b-shard1of3`, `llm-qwen3-0-6b-shard2of3`, and `llm-qwen3-0-6b-shard3of3`, restricted to `stage_llm_qwen3_0_6b_shard1of3`, `stage_llm_qwen3_0_6b_shard2of3`, and `stage_llm_qwen3_0_6b_shard3of3` respectively. With that arrangement each shard stage always lands on the tab that is the only one advertising it, so each shard's state is on the device that needs it in the following round. A second tab advertising the same shard is also safe, because the gateway places each shard back on the tab that ran it for that task, rather than on whichever tab advertising the shard happens to be free; a shard given a round it holds no key-value cache for would return wrong text rather than fail, so this is a fault that would be hard to see. A single tab advertising all three stages also completes the task, but then one device downloads and holds all three shards, which is the situation the project is trying to avoid.

**How to submit one:**

```bash
npm run sample:llm_qwen3_0_6b_sharded --workspace @webai/consumer-cli
```

That script submits the prompt "What is the capital of France?" under the consumer name `llm-qwen3-0-6b-sharded-consumer`. To submit a different prompt, call the command line client directly:

```bash
npm run dev --workspace @webai/consumer-cli -- --type llm_qwen3_0_6b_sharded "Write one sentence about rain."
```

### Task type `task_type_llm_gemma_nano_chrome_full`

**Name:** `task_type_llm_gemma_nano_chrome_full`, served by the pipeline whose identifier is `llm_gemma_nano_chrome_full`, at version 1.

**Input:** one text prompt, which must not be empty.

**What it does:** it generates text with the Gemma Nano language model that is built into the Chrome browser. Nothing about the model is downloaded, held, or run by this project: the browser holds the model, and the worker browser tab asks it for an answer through the browser's own prompt interface, reached through the global `LanguageModel` object.

The browser is asked for the answer once and then produces it in pieces. One run of the stage reads every piece of one answer and returns the complete answer as its result, marked finished, so a task normally completes on its first run. There is a safety bound of 400 pieces per answer, defined in [`packages/worker/web/src/stage_llm_gemma_nano_chrome_helper.ts`](../packages/worker/web/src/stage_llm_gemma_nano_chrome_helper.ts), so a model that never finished an answer could not keep one stage run reading for as long as the page stays open.

The stage used to read one piece per run, with the pipeline repeating for each piece. That cost one message to the gateway and one message back per piece, and each of those messages carried the whole answer so far, so the traffic for one answer grew with the square of its length — while the consumer that submitted the task still saw nothing until the task completed, because a task revision carries no partial text. Reading a whole answer in one run is the first step of [issue 77](https://github.com/webai-at-home/webai-at-home/issues/77); the later steps of that issue bring the piece-at-a-time reading back for a request that asks for its answer to be streamed, and make it carry each new piece rather than the answer so far.

The pipeline still sets `repeatsUntilDone`, and it is the stage reporting `done` that ends the task on its first run.

**Purpose:** it is the lightest language-model task in the project and the simplest end-to-end demonstration that the cluster can generate text at all. It needs no model download, no model files in this repository, no graphics processor of its own, and no cooperation between devices, so it separates the question of whether the coordination path can carry a language-model task from the question of whether a volunteer device can run a model the project ships. That makes it the baseline the two model-downloading tasks can be compared against.

**Stages the cluster must carry out**, one run per answer:

| Order | Stage name | Computation | Input schema | Output schema | Encoding | What this stage does |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `stage_llm_gemma_nano_chrome_full` | `llm_gemma_nano_chrome_full` | `llm@1` | `llm@1` | `inline-json` | It creates a session with the browser's built-in language model, asks it for an answer to the submitted prompt, and reads every piece the browser gives until the answer is finished or the safety bound of 400 pieces is reached. It returns the complete answer, marked finished. |

The stage states a lease of 60000 milliseconds rather than using the gateway default, because creating the session can take far longer than the gateway's own default lease allows for: on a device that has only just downloaded the model, the first session of a page took about 15 seconds in testing. Generating a whole answer takes longer still, and what carries a run past its lease is the stage heartbeat messages the worker sends for the whole time it is generating.

The stage sets `prefersSameWorkerOnRetry`. A run now holds its session and its reader only for its own duration, so a retry after a failure has no state to return to and starts a fresh answer wherever it lands; the setting sends that retry back to the tab that was running the answer, which is in practice the only tab offering the stage. It matters again once a request can ask for a streamed answer, because such an answer is held open across runs in the memory of one tab.

The generation the tab holds while a run is reading it is released when the run finishes, when the stage fails, and when the gateway cancels the assignment. Cancelling is what stops the browser generating an answer whose consumer has gone away, rather than leaving the model producing text nobody will read. A cancellation that arrives before the model session exists is honoured too: the run registers what it holds before it asks for the session, so a cancellation during that wait — the slowest part of a run, at about 15 seconds on a device that has only just downloaded the model — marks the run released, and the run drops the session the moment the browser hands it over instead of generating an answer into it.

A tab holds each generation against the assignment it belongs to, and not against the task. One tab can hold two runs of the same task at once, because a lease that expires while a run is under way has the gateway assign the stage again, and this stage asks for that retry to come back to the same tab. The gateway issues a fresh assignment identifier for every attempt, so each run has its own entry and neither can release the other's session.

**What the cluster needs in order to run it:** one connected worker browser tab in a browser that has its own language model ready. Before a tab advertises the stage it asks the browser how ready that model is, and it only advertises the stage when a session can be created. Three other answers are possible, and each is reported on the page rather than being discovered when work arrives:

- The browser has no built-in language model at all, which is the case for every browser other than a recent Chrome. The tab says so and does not offer the stage.
- The browser has the model but will not run it on this device, usually because of its storage, memory, or graphics requirements. The tab says so and does not offer the stage.
- The browser has the model on offer but has not downloaded it yet. The browser only starts that download when the person using the page asks for it, so the tab shows a button that starts the download, reports its progress, and connects again once the model is ready. Until then the tab does not offer the stage.

A tab that offers no other stage either closes its connection instead of registering, so the gateway never lists a worker that could not do the work. A task submitted while no tab offers the stage waits in the `queued` state.

The normal arrangement is one tab, which is what the page `packages/gateway/web/debug_iframe_llm_gemma_nano_chrome_full/index.html` opens: the gateway monitor page beside one inline frame named `llm-gemma-nano-chrome-full`, restricted to `stage_llm_gemma_nano_chrome_full`.

A second tab advertising the same stage does no harm. Each answer is produced within one run on one tab, so two tabs advertising this stage simply run two answers side by side, and a task that has to be retried starts its answer again on whichever tab receives the retry.

**How to submit one:**

```bash
npm run sample:llm_gemma_nano_chrome_full --workspace @webai/consumer-cli
```

That script submits the prompt "What is the capital of France?" under the consumer name `llm-gemma-nano-chrome-full-consumer`. To submit a different prompt, call the command line client directly:

```bash
npm run dev --workspace @webai/consumer-cli -- --type llm_gemma_nano_chrome_full "Write one sentence about rain."
```

## Every stage in the cluster

Six stage names exist across the three built-in pipelines, using four distinct computations.

| Stage name | Pipeline | Task type | Computation |
| --- | --- | --- | --- |
| `stage_dev_formula_multiply` | `dev_formula` version 1 | `task_type_dev_formula` | `dev_formula_multiply` |
| `stage_dev_formula_add` | `dev_formula` version 1 | `task_type_dev_formula` | `dev_formula_add` |
| `stage_llm_qwen3_0_6b_shard1of3` | `llm_qwen3_0_6b_sharded` version 1 | `task_type_llm_qwen3_0_6b_sharded` | `llm_qwen3_0_6b_shard` |
| `stage_llm_qwen3_0_6b_shard2of3` | `llm_qwen3_0_6b_sharded` version 1 | `task_type_llm_qwen3_0_6b_sharded` | `llm_qwen3_0_6b_shard` |
| `stage_llm_qwen3_0_6b_shard3of3` | `llm_qwen3_0_6b_sharded` version 1 | `task_type_llm_qwen3_0_6b_sharded` | `llm_qwen3_0_6b_shard` |
| `stage_llm_gemma_nano_chrome_full` | `llm_gemma_nano_chrome_full` version 1 | `task_type_llm_gemma_nano_chrome_full` | `llm_gemma_nano_chrome_full` |

A worker browser tab decides which of these it offers by asking the gateway for its loaded pipelines and keeping every stage whose computation the tab implements. The page address may narrow that set further through its `enabledStages` parameter, which is how the three debug pages give each inline frame a single stage. A tab that names no stages at all offers every stage the loaded pipelines define whose computation it implements. The choice is made by `offeredStages` in [`packages/worker/web/src/main.ts`](../packages/worker/web/src/main.ts).

Being able to run a computation is not always enough to offer its stage. A tab drops `stage_llm_gemma_nano_chrome_full` again when its browser's own language model is not ready, and it downloads the shards for the language-model shard stages it offers before it registers, so that a shard is never downloaded while a task waits for it. Both happen between asking for the pipelines and registering.

## The values carried between stages

Every value sent to a stage or returned by one is built by `StagePayloadFactory` in [`packages/protocol/src/stage_payload_factory.ts`](../packages/protocol/src/stage_payload_factory.ts), so the gateway and the worker browsers share one definition of each shape:

- A formula stage carries a plain number, unchanged.
- The first stage of a task is given its value by `StagePayloadFactory.initial`, which answers every task type: the submitted number for a development formula task, and the submitted prompt text for either language-model task. Nothing outside that one method decides what a first stage value looks like.
- The first round of a sharded language-model task carries the submitted prompt text to `stage_llm_qwen3_0_6b_shard1of3`.
- A hand-off from one shard to the next within one round carries the boundary tensors, the token identifiers processed in that round, and the position of the first of those tokens within the whole sequence.
- A third-stage result that continues generation carries the text generated so far, the single token just chosen, that token's position, and `done` set to `false`.
- A third-stage result that ends generation carries the complete generated text and `done` set to `true`.
- A result of the Chrome built-in language-model stage carries the complete answer and `done` set to `true`, exactly as the sharded task's last stage does. One run produces a whole answer, so no result of that stage continues one.
- The `isContinuation` field exists for a payload that continues a generation held open in the memory of the device that produced the previous result. Nothing sets it today; it returns once a request can ask for a streamed answer, which is [issue 77](https://github.com/webai-at-home/webai-at-home/issues/77). A worker given a payload carrying it fails the stage, rather than reading a partial answer as if it were a new prompt.

## Where these definitions live

- Task types and task inputs: `TaskType` and `TaskInput` in [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts).
- Pipeline and stage specifications, including the three built-in pipelines: [`packages/gateway/src/libs/pipeline_registry.ts`](../packages/gateway/src/libs/pipeline_registry.ts).
- The rule that decides which stage comes next, including the repeating case: `TaskStore.nextStage` in [`packages/gateway/src/libs/task_store.ts`](../packages/gateway/src/libs/task_store.ts).
- Stage assignment, worker selection, leases, and retries: [`packages/gateway/src/cli.ts`](../packages/gateway/src/cli.ts).
- The formula computations: [`packages/worker/web/src/stage_dev_formula_helper.ts`](../packages/worker/web/src/stage_dev_formula_helper.ts).
- The language-model shard computation: [`packages/worker/web/src/stage_llm_qwen3_0_6b_helper.ts`](../packages/worker/web/src/stage_llm_qwen3_0_6b_helper.ts).
- The computation that uses the language model built into the browser: [`packages/worker/web/src/stage_llm_gemma_nano_chrome_helper.ts`](../packages/worker/web/src/stage_llm_gemma_nano_chrome_helper.ts).
- Submitting a task from the command line: [`packages/consumer_cli/src/cli.ts`](../packages/consumer_cli/src/cli.ts), [`packages/consumer_cli/src/libs/consumer_client.ts`](../packages/consumer_cli/src/libs/consumer_client.ts), and [`packages/consumer_cli/src/libs/task_input_factory.ts`](../packages/consumer_cli/src/libs/task_input_factory.ts).
- Submitting a task through the OpenAI completion interface, which is the second way a task can be submitted: [`packages/consumer_openai`](../packages/consumer_openai). That server turns one chat completion request into one task of one of the three task types above, chosen by the request's `model` field, and reuses the same `ConsumerClient` and `TaskInputFactory` as the command line client.
