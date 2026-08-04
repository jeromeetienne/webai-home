# SmolLM2-360M · Transformers.js

Loads [`eduardoworrel/SmolLM2-360M-Instruct`](https://huggingface.co/eduardoworrel/SmolLM2-360M-Instruct) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js) and runs one
streamed chat completion in the browser, at `q4` quantization.

## Run

Start the dev server from the package root and open `smoll2-360m/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The button downloads the model through Transformers.js, runs it on WebGPU when available (WebAssembly otherwise),
and streams the generated tokens into the page. The model files are cached by the browser (IndexedDB), so later page
loads skip the download.

See [`src/main.ts`](src/main.ts) for the pipeline setup and [`../../README.md`](../../README.md) for the other
experiments in this package.
