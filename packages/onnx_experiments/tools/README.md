# Qwen3 shard exporter

The browser page expects three files in
`public/onnxruntime_qwen3-0.6b-with-shards/shards/`. The files are generated artifacts and
are intentionally ignored by Git because they are about 1.7 GB in total.

Create the repository-local environment and install the exporter dependency:

```sh
python3.13 -m venv packages/onnx_experiments/tools/.venv
packages/onnx_experiments/tools/.venv/bin/pip install -r packages/onnx_experiments/tools/requirements.txt
```

Download the source model and export the three shards:

```sh
curl -L --fail --output /tmp/qwen3-model_q4f16.onnx \
  https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_q4f16.onnx
packages/onnx_experiments/tools/.venv/bin/python packages/onnx_experiments/tools/split_qwen3_onnx.py \
  /tmp/qwen3-model_q4f16.onnx \
  packages/onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/shards
```

The exporter creates independent graphs with these boundaries:

- Shard 1: token embedding, decoder layers 0–8, and the layer 9 input normalisation.
- Shard 2: decoder layers 9–18 and the layer 19 input normalisation.
- Shard 3: decoder layers 19–27, final RMSNorm, and the language-model output head.

The input normalisation boundary carries both the normalised activation and the
residual activation because the exported Qwen3 graph uses fused skip-normalisation
operators. The browser passes those two tensors, along with each shard's local
key/value cache, from one session to the next.

Verify three autoregressive steps with ONNX Runtime Node:

```sh
node packages/onnx_experiments/tools/verify_qwen3_shards.mjs
```

Pass the original monolithic model as an optional argument to compare the first
shard pipeline result against the original graph:

```sh
node packages/onnx_experiments/tools/verify_qwen3_shards.mjs /tmp/qwen3-model_q4f16.onnx
```
