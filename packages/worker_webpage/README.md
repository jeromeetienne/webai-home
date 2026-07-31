# `@webai/worker-webpage`

Build and serve the worker browser independently from the central gateway:

```sh
npm run build --workspace @webai/worker-webpage
npm run start --workspace @webai/worker-webpage
```

During development, use `npm run dev --workspace @webai/worker-webpage`. Vite
serves the page on port `8789` by default. The page connects to the central
gateway at `http://localhost:8787` and authenticates with
`development-token` by default. Use `?gatewayUrl=http://host:port` and
`?authToken=token` to connect to a different gateway.

Use `?workerName=name` to choose the registered worker name. Use repeated
`?enabledStages=stage_name` parameters to restrict the stages offered by a
worker. When no stage parameters are provided, the page advertises all
available built-in stages.

Worker pages can receive multiple enabled stages through repeated URL parameters. For example:

```text
?gatewayUrl=http://localhost:8787&workerName=formula-worker&enabledStages=stage_dev_formula_multiply&enabledStages=stage_dev_formula_add
```

When no enabled stages are provided, the worker advertises all available formula and language-model stages.

## Qwen3 model shards

The three Qwen3-0.6B ONNX model shards are stored in the public [Hugging Face model repository](https://huggingface.co/jerome-etienne/webai-at-home-qwen3-0.6b-shards), rather than in the Worker web build or the central gateway. The Worker downloads only the shard assigned to its stage and stores downloaded shard bytes in the browser's IndexedDB cache.

The Worker uses the immutable Hugging Face revision [`8ba2b869c4dbb96de8b72e448e79b4ec5825ae47`](https://huggingface.co/jerome-etienne/webai-at-home-qwen3-0.6b-shards/tree/8ba2b869c4dbb96de8b72e448e79b4ec5825ae47). Upload a new model revision and update the revision in `web/src/stage_llm_qwen3_0_6b_helper.ts` when the shard files change. The GitHub Pages Worker deployment therefore publishes the small application and runtime assets, not the roughly 860 megabytes of model shards.

## Chrome Apps on device permission

The deployed Worker page is served from GitHub Pages, but it connects to the central gateway running on the local computer at `http://localhost:8787` by default. Chrome calls this connection an **Apps on device** request because the page is contacting software running on the computer.

Chrome asks for this permission to protect local services from unexpected requests made by websites. Allow the permission when using the deployed Worker with a local gateway. The permission is not needed for downloading model shards from Hugging Face or for using the graphics processor. Select **Reset permission** in Chrome's site information panel to remove the permission; Chrome will ask again the next time the Worker connects to the local gateway.

## Connection lifetime

The page connects to the central gateway as soon as it loads, and keeps that connection for as long as it is the page the browser tab displays. Moving the browser tab to another page closes the connection, so the gateway stops counting this browser as a connected worker and stops giving it work. A browser tab keeps the page it left in its back/forward cache rather than destroying it, so this has to be done as the page is put away; otherwise the page keeps its connection open while nobody is looking at it. Going back to the page opens a new connection, and the gateway registers the worker again under a new device identifier.

Switching to another browser tab is not the same thing as leaving the page: a worker page in a background tab keeps its connection and keeps running the work it has been given.
