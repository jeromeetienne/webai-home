# Qwen3.5-0.8B · Issue #96 de-risk gate

Loads [`onnx-community/Qwen3.5-0.8B-ONNX`](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js) and runs one
streamed chat completion in the browser, at `q4f16` quantization.

This page is the de-risk gate for issue #96: a real ONNX Runtime Web + WebGPU run of the pinned export, proving the
merged decoder's hybrid linear-attention/full-attention cache (`past_conv`/`past_recurrent` plus `past_key_values` on
every fourth layer) actually loads and generates. The Hugging Face revision is pinned in
[`src/main.ts`](src/main.ts) so a moving `main` branch cannot change what the gate measured.

## Run

Start the dev server from the package root and open `qwen3_5-0.8b-gate/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The button downloads the model through Transformers.js, runs it on WebGPU when available (WebAssembly otherwise),
and streams the generated tokens into the page. The model files are cached by the browser (IndexedDB), so later page
loads skip the download.

See [`../../README.md`](../../README.md) for the other experiments in this package.
