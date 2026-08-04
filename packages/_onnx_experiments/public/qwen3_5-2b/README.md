# Qwen3.5-2B · Transformers.js

Loads [`onnx-community/Qwen3.5-2B-ONNX`](https://huggingface.co/onnx-community/Qwen3.5-2B-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js) and runs one
streamed chat completion in the browser, at `q4f16` quantization.

Qwen3.5-2B shares the same merged-decoder export layout as the pinned Qwen3.5-0.8B model verified in
[`../qwen3_5-0.8b-gate`](../qwen3_5-0.8b-gate) — a hybrid linear-attention/full-attention decoder
(`past_conv`/`past_recurrent` plus `past_key_values` on every fourth layer) — so this experiment reuses the same
Transformers.js `text-generation` pipeline. The Hugging Face revision is pinned in
[`src/main.ts`](src/main.ts) so a moving `main` branch cannot change what this experiment measured. The `q4f16`
decoder and token embedding weights total roughly 1.4 GB, larger than the 0.8B model, so the first load takes longer.

## Run

Start the dev server from the package root and open `qwen3_5-2b/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The button downloads the model through Transformers.js, runs it on WebGPU when available (WebAssembly otherwise),
and streams the generated tokens into the page. The model files are cached by the browser (IndexedDB), so later page
loads skip the download.

See [`../../README.md`](../../README.md) for the other experiments in this package.
