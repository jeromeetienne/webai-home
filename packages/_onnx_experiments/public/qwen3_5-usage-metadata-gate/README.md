# Qwen3.5-0.8B · Issue #150 usage metadata de-risk gate

Loads [`onnx-community/Qwen3.5-0.8B-ONNX`](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js), at the same
pinned revision and `q4f16` quantization as
[`stage_helper_llm_qwen3_5_0_8b_full.ts`](../../../worker_webpage/web/src/stages/stage_helper_llm_qwen3_5_0_8b_full.ts),
and runs four generations in the browser.

This page is milestone 0's gate for [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150): does the
tokenizer give an exact token count for a prompt and for an answer, and can reaching `MAX_NEW_TOKENS`, the
end-of-sequence token, and an interruption be told apart afterwards?

- **Phase 1** — tokenizes a plain prompt string, and the same prompt with the chat template applied, and reports the
  exact token count both ways.
- **Phase 2** — generates with a generous cap and lets the model stop on its own, then checks whether the last
  generated token id is in `eos_token_id`.
- **Phase 3** — generates with `max_new_tokens: 5`, small enough that the cap is what stops it, not the model.
- **Phase 4** — calls `InterruptableStoppingCriteria.interrupt()` from inside the token callback, after 3 tokens,
  the same way the real stage's `clearGeneration`/`release` does, and checks `criteria.interrupted`.

## Run

Start the dev server from the package root and open `qwen3_5-usage-metadata-gate/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The model files are cached by the browser (IndexedDB), so a browser that already ran
[`qwen3_5-0.8b-gate`](../qwen3_5-0.8b-gate/) does not re-download them.

See [`../../README.md`](../../README.md) for the other experiments in this package.
