# webai-home

## Goal

`webai-home` explores whether idle web browsers can work together to run a
large language model that is too large for any one volunteer device.

The project treats computing time as a form of contribution. A person should
be able to open a web page on an old laptop, phone, or other device and leave
the page running. The browser then contributes one part of a shared inference
pipeline, without installing an application or downloading the entire model.

The aim is to make volunteer computing for large language models as simple as
visiting a web page. Many small contributions should combine into a useful
service for a cause or community, reusing hardware that would otherwise sit
idle.

## How the idea works

- A coordinator keeps a queue of batch requests. The requests can take hours
  rather than needing an immediate answer.
- The coordinator divides a model into sequential groups of layers and gives
  each group to a connected browser tab.
- Each browser downloads and caches only its assigned model part.
- Intermediate results move from one browser to the next through direct
  browser connections when possible.
- The coordinator measures each device and sizes assignments according to the
  device’s available memory and speed.
- If a volunteer device disconnects, the unfinished work can be assigned to
  another device.

This project focuses on pipeline parallelism: each device runs a different
section of the model. This approach passes one result between sections and is
better suited to slow and uneven home internet connections than approaches
that require every device to synchronise after every model operation.

The first implementation uses ONNX Runtime Web, with Web Neural Network API
or Web Graphics Processing Unit API acceleration where available and WebAssembly
as a Central Processing Unit fallback.

## Why batch work

`webai-home` is not intended to provide live chat response times. A generous
deadline makes volunteer computing practical:

- disconnected tabs can be replaced;
- the coordinator can keep each stage busy with a queue of work;
- slow devices and network connections can still be useful;
- volunteers can contribute when their devices are available.

## Current state

This repository contains early experiments and a minimal distributed pipeline.
The current server prototype assigns two simple formula stages to volunteer
browsers. The ONNX experiments test running model work directly in browsers,
including a small Iris classifier and larger model experiments.

The central research questions are still open, especially result verification,
browser tab throttling, volunteer and coordinator trust, and reliable model
partitioning across very different devices.

## Repository layout

- `packages/server` — coordinator HTTP and WebSocket server, scheduling, and
  administrator and volunteer pages.
- `packages/protocol` — shared message and task definitions with validation.
- `packages/task_client` — command-line client for submitting test tasks.
- `packages/onnx_experiments` — browser experiments for ONNX Runtime Web.
- `packages/tiny_iris_classifier` — small end-to-end browser inference example.

## Run the prototype

```sh
npm install
npm run dev:server
npm run dev --workspace @webai/task-client -- 5
```

Open `http://localhost:8787/volunteer` in two browser tabs and
`http://localhost:8787/admin` in an administrator browser tab. The prototype
currently runs a formula pipeline whose first stage multiplies by `2` and
whose second stage adds `7`.

## Long-term direction

The intended next step is a small proof of concept using two or three older
devices, a small quantised model, browser inference, and browser-to-browser
connections. Measurements from that proof of concept will show whether the
pipeline remains useful under real device churn, memory limits, and network
latency.

See [issue #1](https://github.com/jeromeetienne/webai-home/issues/1) for the
full project concept and its open questions.
