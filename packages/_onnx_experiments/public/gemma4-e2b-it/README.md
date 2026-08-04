# Gemma 4 E2B-it · Transformers.js

Loads [`onnx-community/gemma-4-E2B-it-ONNX`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js) and runs one
streamed chat completion in the browser, at `q4f16` quantization.

## Run

Start the dev server from the package root and open `gemma4-e2b-it/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The button downloads the model through Transformers.js, runs it on WebGPU when available (WebAssembly otherwise),
and streams the generated tokens into the page. The model files are cached by the browser (IndexedDB), so later page
loads skip the download.

See [`src/main.ts`](src/main.ts) for the pipeline setup and [`../../README.md`](../../README.md) for the other
experiments in this package.
