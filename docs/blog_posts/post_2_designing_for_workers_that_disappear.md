# Designing for Workers That Disappear

In the [previous post](./post_1_inference_without_permission.md) I argued that running a language model should not require anyone's permission, and that the way to get there is to borrow computing time from idle browser tabs on devices people already own.

This post is about the problem that creates.

Every worker in this system is a browser tab belonging to a stranger who owes me nothing. They can close it. Their laptop can go to sleep. Their home internet can drop for eleven seconds in the middle of a computation. They can walk away from the machine entirely and never come back.

None of that is an error condition. It is the normal operating state, and it is the thing the whole architecture is shaped around. What follows is what that shape actually looks like.

## The choice that makes disappearance survivable

Start with the decision that constrains everything after it: how to split a model.

The approach used inside a data centre is to split every layer across all the machines, so each machine holds a slice of every layer and they all work on the same layer simultaneously. It is fast, and it requires every machine to synchronise with every other machine after every operation. On a rack with a fast local network that is fine. Across a dozen home internet connections, where one volunteer is on fibre and another is on a phone in a basement, it is hopeless — the whole group runs at the speed of the worst connection, constantly.

**Pipeline parallelism** splits the stack instead of the layers. The first device holds the first group of layers, the second holds the next group, and so on. A value flows through them in order.

The thing to look at is what actually travels between devices. In the Qwen3-0.6B pipeline the model is cut at two fixed points — the input layer normalization of layer 9, and of layer 19. At each boundary exactly two arrays of numbers cross the wire: the normalized values and the residual values. That is it. Everything else the shard needs, it already has.

So the network cost is one small handoff per boundary rather than continuous synchronisation, and — this is the part that matters for volunteers — a device that vanishes takes down one link in a chain rather than stalling a group that was waiting on it in lockstep.

## Leases, not health checks

When the coordinator gives a stage to a browser tab, it does not ask that tab to promise anything. It sets an expiry.

Every stage assignment carries a lease with a deadline. The default is 15 seconds. Stages that run a real model set their own, longer value — 60 seconds for the model-running stages — because on a device that has only just downloaded the model, merely creating the model session took around 15 seconds in testing, before a single token was produced.

While a worker is genuinely still working, it sends stage heartbeat messages, and each one pushes the deadline further out. So the lease answers a question a health check cannot: not "is this tab still connected?" but "is this tab still making progress on *my* task?" A tab can be perfectly connected and completely stuck, and a heartbeat-extended lease catches that where a connection check does not.

When the deadline passes with no heartbeat, the coordinator stops waiting and gives the work to somebody else. The volunteer is never asked, never notified, and never blamed. They closed a tab. That is allowed.

## What gets retried, and what does not

Retries are bounded: three attempts per stage by default.

There is a distinction here that took me a while to get right, and I think it is the correct one. Two very different things can go wrong, and they deserve opposite treatment:

- **The worker went away.** A lease expired, a connection dropped, a tab closed. Nobody learned anything. Try again somewhere else — this is what the attempt limit counts.
- **The worker reported a failure.** It ran the code and the code failed. Retrying that on another device means running the same failing code again for the same result, three times, before admitting it. So a failure a worker actually reports fails the task immediately.

The attempt limit exists to bound disappearance, not to paper over broken code.

There is a third case which is neither. When *no connected worker advertises the stage that comes next*, the task is not failed at all — it goes back into the queued state and waits. Nobody is available to run the second half of a model right now, and that is a completely ordinary situation in a volunteer system. The task waits for someone to open a tab. What bounds the wait is the submission deadline, and because this is deliberately built for work that can take hours, that deadline is generous enough for waiting to be a real strategy rather than a disguised failure.

## The genuinely hard part: state in someone else's memory

Everything above is manageable. Here is the part that is not.

Some stages hold state in the memory of the device running them. When a shard of Qwen3-0.6B produces a token, it keeps a key-value cache — the intermediate values computed for every token so far, kept so they do not have to be recomputed from scratch on the next round. The last shard additionally keeps the list of tokens generated so far.

This state stays in the browser tab. It is never sent to the coordinator. That is a deliberate choice: sending the cache over the connection every round would swamp the small handoff arrays that make pipeline parallelism affordable in the first place. The cost of keeping it in the tab is that the state and the device are now welded together.

So for these stages, placement is not a load-balancing decision. It is a correctness requirement.

My first instinct was to send the next stage back to the device that just finished a stage. That is wrong, and the reason is worth spelling out.

The Qwen3-0.6B pipeline **repeats**. Three shards run in order to produce one token, and then it starts again from the first shard for the next token, over and over until the model signals it is done or hits the safety limit of 160 tokens. Now think about which device holds the state that the upcoming stage needs. It is not the device that ran most recently. It is the device that ran *that same stage* on the previous round — one full lap ago, two devices back.

So the coordinator records, on the task itself, which device most recently completed each stage of that task. When a stage needs to be placed, that per-stage record is consulted first, and the device that just finished anything is only the fallback — used for the first round of a repeating pipeline, and for pipelines where one stage hands its state to the next on the same device.

Here is the whole decision, which is pleasingly small:

```ts
static preferredWorkerDeviceId(task, upcomingStage, policy, previousWorkerDeviceId) {
	if (policy.prefersSameWorkerOnRetry === false) return undefined;
	return task.stageWorkerDeviceIds?.[upcomingStage] ?? previousWorkerDeviceId;
}
```

Note what is absent from that file: no stage name, and no task type. Whether a stage keeps state is declared by the stage's own pipeline definition, through a flag called `prefersSameWorkerOnRetry`, and arrives here as a resolved policy. The placement logic does not know that language models exist.

## A preference, not a guarantee

The preferred device is only preferred. It may have disconnected, may be shutting down, may have stopped offering that stage, or may already be running as many assignments as its own declared limit allows. In any of those cases the stage goes to another device that advertises it, and if no such device exists, it fails there and says so.

But there is one case where the coordinator refuses to place the work elsewhere at all. In the Chrome built-in model pipeline, an answer being read out piece by piece lives inside one tab's open generation session and nowhere else. Sending the continuation of that answer to a different tab could not possibly succeed. Rather than hand it somewhere it can only fail, the coordinator puts the task back in the queue and waits for the tab holding the answer to become free.

And one honest warning about the sharded pipeline. If a shard were given a round it holds no cache for, it would not crash. It would produce *wrong text*, confidently. A fault that fails loudly is a nuisance; a fault that silently degrades output quality is the kind you ship without noticing. The normal arrangement — one tab per shard, each advertising only its own stage — makes it structurally hard to hit, but "structurally hard to hit" is not the same as "prevented", and this is on my list of things that need a real guard rather than a favourable arrangement.

## Pipelines are data, not code

The last piece is the one I am most pleased with, and it is what keeps all of the above from calcifying.

A pipeline is not a function in the coordinator. It is a specification: it names the task type it serves, its version, and its ordered list of stages, with each stage stating its input schema, its output schema, how the value is encoded, and optionally its own lease duration and state-affinity flag.

When a task is submitted, the coordinator selects the highest version among the pipelines that serve that task type and are not retired, and **copies that stage sequence onto the task**. The sequence is data the task carries from then on. A pipeline registered later, or a new version added, cannot change how a task already in flight will run. Versions are immutable once a task has selected one.

Then there is the separation that makes this genuinely useful. Two different names are involved in every stage:

- The **stage name** identifies one step of one pipeline — `stage_dev_formula_multiply`.
- The **computation** identifies the code that carries it out — `dev_formula_multiply`.

A worker decides what to run from the computation, and never from the stage name. All three shard stages of the Qwen3-0.6B pipeline name the same computation, `llm_qwen3_0_6b_shard`; the coordinator tells each assignment its position within the pipeline, and the worker uses that position as the shard number.

The consequence is that a pipeline supplied at startup through a `--pipeline-file` option can introduce stage names that have never existed before, reusing code the volunteer browsers already contain, **without rebuilding or redeploying a single worker**. In a system whose workers are browser tabs on other people's machines, that property is not a convenience. It is the difference between being able to change the system and not.

The coordinator is also the authority on which stage names exist: a worker that advertises a stage no loaded pipeline defines is refused. Schema validation cannot catch that, because a name can be perfectly well-formed and still refer to nothing.

This is why the project has a naming document that reads as if it were written by somebody with too much time. Every name is built from a domain, a model, and a topology — `stage_llm_qwen3_0_6b_shard2of3` says which kind of work, which model, and how it is arranged, on sight. When your stage names are data that arrives from a file at startup rather than symbols the compiler checks, precise naming stops being tidiness and starts being a correctness tool.

## Debugging something that happens on four machines at once

One last practical note. When a distributed system misbehaves, the bug is usually not inside any one component — it is in the *ordering* of messages between them, and no single machine's log contains the whole story.

So the coordinator records its message traffic, and a separate viewer replays it: consumers, coordinator, and worker browsers, with the messages flowing between them, playable at adjustable speed. I built it because reading four logs side by side and reconstructing the sequence in my head was not working, and I should have built it earlier than I did.

## Next

None of this has yet proven anything about usefulness. A system that survives disappearing workers with perfect grace is still worthless if nobody can point their existing software at it.

The next post is about that: an interface that lets any program already written against OpenAI use this cluster by changing one line — and why that is the point of the whole exercise rather than a convenience layer bolted on the end.

The code is at [github.com/webai-at-home/webai-at-home](https://github.com/webai-at-home/webai-at-home).
