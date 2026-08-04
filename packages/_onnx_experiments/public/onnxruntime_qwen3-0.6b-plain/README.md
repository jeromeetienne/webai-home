# Qwen3-0.6B · ONNX Runtime Web, plain

Runs [`onnx-community/Qwen3-0.6B-ONNX`](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX) directly through
[`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web), bypassing Transformers.js, with a single
`q4f16` ONNX model file and a [`@huggingface/tokenizers`](https://www.npmjs.com/package/@huggingface/tokenizers)
tokenizer. It runs the autoregressive decode loop and the key/value cache management by hand, and logs the layer
configuration and per-step tensor shapes to the browser console.

## Run

Start the dev server from the package root and open `onnxruntime_qwen3-0.6b-plain/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

No generated shard files are needed — this experiment loads the model in one request. The model file is cached by
the browser (IndexedDB), so later page loads skip the download.

See [`src/model_helper.ts`](src/model_helper.ts) for the ONNX Runtime session setup, [`src/main.ts`](src/main.ts)
for the decode loop, and [`../../README.md`](../../README.md) for the other experiments in this package.
