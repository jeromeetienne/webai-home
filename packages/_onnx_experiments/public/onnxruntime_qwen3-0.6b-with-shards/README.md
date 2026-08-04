# Qwen3-0.6B · ONNX Runtime Web, sharded

Runs [`onnx-community/Qwen3-0.6B-ONNX`](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX) directly through
[`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web), bypassing Transformers.js, split into three
independent ONNX graphs (embedding plus decoder layers 0–8, decoder layers 9–18, decoder layers 19–27 plus the
output head) so the browser can load and run each shard as a separate ONNX Runtime Web session.

This experiment needs the generated shard files, which are not checked into Git because they total about 1.7 GB. See
[`../../tools/README.md`](../../tools/README.md) for the exporter that produces
`shards/shard-1.onnx`, `shards/shard-2.onnx`, and `shards/shard-3.onnx` before opening this page.

## Run

Generate the shards (once), then start the dev server from the package root and open
`onnxruntime_qwen3-0.6b-with-shards/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

See [`src/model_helper.ts`](src/model_helper.ts) for the per-shard ONNX Runtime session setup,
[`src/main.ts`](src/main.ts) for the decode loop that passes activations and key/value caches between shards, and
[`../../README.md`](../../README.md) for the other experiments in this package.
