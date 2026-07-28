# Protocol by role

This document describes the current WebSocket protocol between the actors in
`webai-at-home`. The protocol is implemented in
[`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts). The
protocol is an early prototype and does not yet define authentication,
reconnection, durable task storage, or message version negotiation.

## Actors

### Gateway

The gateway is the coordinator. The gateway accepts WebSocket connections,
assigns each connection a `deviceId`, validates incoming messages, keeps the
device registry and in-memory task store, assigns stages to workers, and
broadcasts task and worker updates.

The gateway is the only actor that schedules stages. Workers and consumers do
not send messages directly to each other for task processing. The gateway
relays signalling messages when a connection needs to exchange peer-connection
data.

### Consumer

A consumer submits work and receives task state. A consumer registers with
`role: "consumer"`, then submits a formula number or language-model prompt.
The consumer receives the accepted task and later task updates. The command
line consumer closes its connection when the task reaches `completed` or
`failed`.

### Worker

A worker is a browser tab that performs one or more named stages. A worker
registers its name and the stages that it supports. The gateway sends a
`stage.assign` message when the worker is selected. The worker computes the
stage and replies with either `stage.result` or `stage.failed`.

For formula tasks, the gateway normally uses different workers for the two
stages when suitable workers are available. For language-model tasks, all
shards of one task remain on the same worker so that the worker can retain its
in-memory key-value cache between generation rounds.

### Observer

An observer is a read-only connection used by the gateway home page and flow
viewer-style tooling. An observer sends `observe` and receives the current
worker list. An observer is not added to the worker registry and cannot submit
tasks or return stage results.

## Connection and registration

All actors use a WebSocket connection to the gateway. The gateway creates a
device identifier when the connection opens and returns that identifier after a
successful registration.

The client sends one of these initial messages:

```json
{ "type": "register", "role": "consumer", "name": "consumer" }
```

```json
{
  "type": "register",
  "role": "worker",
  "name": "browser-worker-a",
  "stageNames": ["stage_formula_multiply", "stage_formula_add"]
}
```

The gateway replies to either registered role with:

```json
{ "type": "registered", "deviceId": "device-..." }
```

The gateway replaces an existing worker connection when a newer worker uses the
same worker name. Closing a connection removes the device from the registry
and causes the gateway to broadcast a fresh worker list.

An observer sends:

```json
{ "type": "observe" }
```

The gateway replies with `devices` and does not send `registered`.

## Message direction by role

| Message | Sender | Receiver | Purpose |
| --- | --- | --- | --- |
| `observe` | Observer | Gateway | Request the current worker list. |
| `register` | Consumer or worker | Gateway | Declare the connection role, name, and worker stages. |
| `registered` | Gateway | Consumer or worker | Confirm registration and provide `deviceId`. |
| `task.submit` | Consumer | Gateway | Submit a validated formula or language-model task input. |
| `task.accepted` | Gateway | Consumer | Return the newly created task. |
| `task.get` | Registered client | Gateway | Request one task by identifier. |
| `task.updated` | Gateway | Registered clients | Broadcast or return the current task state. |
| `stage.assign` | Gateway | Worker | Ask a worker to execute one stage for one task. |
| `stage.result` | Worker | Gateway | Return the output of the expected next stage. |
| `stage.failed` | Worker | Gateway | Report that a stage could not be completed. |
| `signal` | Any connected client | Gateway, then target client | Relay peer-connection signalling data. |
| `devices` | Gateway | Observers and registered clients | Report currently connected workers. |
| `error` | Gateway | The requesting client | Report invalid input, an unexpected stage, or another protocol error. |
| `log.entry` | Worker | Gateway | Relay a worker's message log entry so the gateway can write it to disk. |

`log.entry` is an operational message rather than part of task execution. The
gateway records its own traffic and stores relayed worker traffic in the
gateway log directory.

## Task submission flow

1. A consumer registers with the gateway.
2. After `registered`, the consumer sends `task.submit`.
3. The gateway validates `TaskInput`, creates a task in `queued` state, and
   returns `task.accepted`.
4. The gateway chooses the first worker that advertises the first stage and
   sends `stage.assign`.
5. The worker computes the assigned stage and sends `stage.result`.
6. The gateway checks that the returned stage is the expected next stage,
   stores the result, and either assigns the next stage or completes the task.
7. The gateway broadcasts `task.updated` after each state change. The task
   ends in `completed` with `result`, or in `failed` with `error`.

The current task states are `queued`, `assigned`, `running`, `completed`,
`failed`, and `cancelled`. The prototype currently sets `queued`, `assigned`,
`completed`, and `failed`; the other states are reserved for future behaviour.

## Stage payloads and flows

### Formula flow

The formula task sequence is:

```text
consumer --task.submit--> gateway
gateway --stage.assign(stage_formula_multiply)--> worker A
worker A --stage.result(number)--> gateway
gateway --stage.assign(stage_formula_add)--> worker B
worker B --stage.result(number)--> gateway
gateway --task.updated(completed)--> consumer
```

The current formula stages multiply the input by `2` and then add `7`.

### Language-model flow

The language-model task sequence cycles through three shards:

```text
stage_llm_shard1 -> stage_llm_shard2 -> stage_llm_shard3
                 -> stage_llm_shard1 -> ...
```

The first assignment carries the prompt in `LlmStagePayload.text`. Intermediate
assignments carry encoded boundary tensors, token identifiers, and the token
position. The final shard returns generated text and sets `done: true` when
generation is complete. When `done` is false, the final shard returns the next
token and the gateway starts another cycle at `stage_llm_shard1`.

An encoded tensor contains `dims`, `type`, and base64-encoded data. The current
JSON tensor encoding is a probe format and is not a final compatibility
contract.

## Validation and errors

The shared protocol package validates task input at the gateway boundary. The
gateway rejects malformed task input with `error`. The gateway also rejects:

- stage results or stage failures from a client that is not a registered worker;
- a stage result that is not the task's expected next stage;
- a `task.get` request for an unknown task.

The worker reports computation errors with `stage.failed`. The gateway marks the
task as `failed` and broadcasts the failure. A disconnected worker is removed
from the registry, but the current prototype does not automatically retry an
unfinished assignment.

## Related implementation

- Shared message types: [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts)
- Gateway routing and scheduling: [`packages/gateway/src/cli.ts`](../packages/gateway/src/cli.ts)
- Task state and stage sequencing: [`packages/gateway/src/libs/task_store.ts`](../packages/gateway/src/libs/task_store.ts)
- Worker registration and stage execution: [`packages/worker/public/src/main.ts`](../packages/worker/public/src/main.ts)
- Consumer registration and task submission: [`packages/consumer/src/consumer_client.ts`](../packages/consumer/src/consumer_client.ts)

## Open protocol decisions

The following decisions should be made before treating this document as a
stable public protocol:

- message versioning and compatibility rules;
- authentication and authorization for consumers, workers, and observers;
- task ownership and which consumers may receive `task.updated`;
- acknowledgement, timeout, retry, and reassignment rules;
- validation schemas for every message and for stage payloads;
- size limits and a production encoding for tensors;
- whether signalling is still required when direct browser connections are
  introduced;
- privacy and retention rules for prompts, results, and logs.
