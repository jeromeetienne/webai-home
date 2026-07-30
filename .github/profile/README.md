# WebAI@Home

WebAI@Home explores whether idle web browsers can work together to run
large language models that are too large for any one volunteer device.

The project aims to make volunteer computing as simple as opening a web page.
Each browser contributes a part of a shared inference pipeline, using only the
model data assigned to that browser. Many small contributions can then combine
to provide useful batch computing for a community or cause.

## How it works

- A gateway keeps a queue of batch requests.
- The gateway divides a model into sequential groups of layers.
- Connected browser workers run individual groups of layers.
- Intermediate results move from one worker to the next.
- The gateway can reassign unfinished work when a worker disconnects.

The project focuses on pipeline parallelism, which is designed for slow and
uneven home internet connections. The first implementation uses ONNX Runtime
Web, with Web Neural Network API or Web Graphics Processing Unit API
acceleration where available and WebAssembly as a Central Processing Unit
fallback.

## Current project

The main repository contains an early distributed pipeline prototype. The
prototype currently supports simple formula pipelines, a Qwen3-0.6B model
split across browser workers, and the Gemma Nano model built into Chrome. The
repository also contains browser experiments for ONNX Runtime Web, a command-
line consumer, an OpenAI-compatible server, and tools for inspecting recorded
message traffic.

The work is still exploratory. Important open questions include result
verification, browser throttling, volunteer and coordinator trust, and reliable
model partitioning across different devices.

## Get started

See the [WebAI@Home repository](https://github.com/webai-at-home/webai-at-home)
for the source code, setup instructions, package documentation, and current
research notes.

```sh
git clone https://github.com/webai-at-home/webai-at-home.git
cd webai-at-home
npm install
npm run dev:gateway
```

The repository includes a small local demonstration that can be run with
browser workers and a command-line consumer.

## Contributing

Issues, experiments, measurements, and careful documentation are welcome.
Please read the repository guidance and open an issue before starting larger
changes.

- [Source code](https://github.com/webai-at-home/webai-at-home)
- [Issues](https://github.com/webai-at-home/webai-at-home/issues)
- [Project concept and open questions](https://github.com/webai-at-home/webai-at-home/issues/1)
