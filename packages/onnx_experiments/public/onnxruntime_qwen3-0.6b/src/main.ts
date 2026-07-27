import * as ort from 'onnxruntime-web';
import { Tokenizer } from '@huggingface/tokenizers';

const MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
const MODEL_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/onnx/model_q4f16.onnx`;
const TOKENIZER_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer.json`;
const TOKENIZER_CONFIG_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer_config.json`;
const EOS_TOKEN_ID = 151645;
const MAX_NEW_TOKENS = 160;

type TensorMap = Record<string, ort.Tensor>;

ort.env.wasm.wasmPaths = '/';
ort.env.logLevel = 'error';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('The page must contain an #app element.');

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <a class="back-link" href="../">← All experiments</a>
      <span class="runtime-pill"><i></i><span id="runtime-label">Checking runtime</span></span>
    </header>
    <section class="hero">
      <p class="eyebrow">Browser inference / field test 04</p>
      <h1>Qwen3<br /><em>onnxruntime_qwen3-0.6b</em></h1>
      <p class="intro">Qwen3-0.6B-ONNX running through ONNX Runtime Web directly in this browser. The tokenizer and model session are loaded without Transformers.js.</p>
    </section>
    <section class="test-panel" aria-labelledby="test-heading">
      <div class="panel-heading">
        <div><p class="section-label">Test prompt</p><h2 id="test-heading">A small question, a useful answer.</h2></div>
        <span class="model-tag">${MODEL_ID} · model_q4f16.onnx</span>
      </div>
      <label class="sr-only" for="prompt">Prompt</label>
      <textarea id="prompt" rows="3">Explain in two short sentences why running a language model in the browser can be useful.</textarea>
      <div class="controls">
        <button id="run-button" class="primary-button" type="button">Load model &amp; run inference <span>↗</span></button>
        <span class="hint">Greedy decoding · direct ONNX Runtime Web</span>
      </div>
    </section>
    <section class="results" aria-live="polite">
      <div class="result-copy"><p class="section-label">Output</p><p id="output" class="output-text placeholder">Run the experiment to see the model's answer.</p></div>
      <div class="metrics">
        <div class="metric"><span>Model load</span><strong id="load-time">—</strong></div>
        <div class="metric"><span>Generation</span><strong id="generation-time">—</strong></div>
        <div class="metric"><span>Output rate</span><strong id="speed">—</strong></div>
        <div class="metric"><span>Backend</span><strong id="backend">—</strong></div>
      </div>
    </section>
    <p id="status" class="status">Ready. The first run downloads the 570 MB quantized ONNX model.</p>
    <footer><span>ONNX Runtime Web + Hugging Face Tokenizers</span><span>Local inference · no prompt upload</span></footer>
  </main>
`;

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`The page must contain ${selector}.`);
  return element;
}

const button = getElement<HTMLButtonElement>('#run-button');
const status = getElement<HTMLElement>('#status');
const output = getElement<HTMLElement>('#output');
const runtimeLabel = getElement<HTMLElement>('#runtime-label');
const backend = getElement<HTMLElement>('#backend');
const hasWebGPU = 'gpu' in navigator;
runtimeLabel.textContent = hasWebGPU ? 'WebGPU available' : 'WebAssembly fallback';
backend.textContent = hasWebGPU ? 'WebGPU' : 'WebAssembly';

let session: ort.InferenceSession | undefined;
let tokenizer: Tokenizer | undefined;
let loadPromise: Promise<void> | undefined;

function setStatus(message: string): void {
  status.textContent = message;
}

async function loadModel(): Promise<void> {
  if (session && tokenizer) return;
  if (loadPromise) return loadPromise;

  const startedAt = performance.now();
  setStatus(`Downloading ${MODEL_ID}. The first run can take a while…`);
  loadPromise = Promise.all([
    fetch(TOKENIZER_URL).then(async (response) => {
      if (!response.ok) throw new Error(`Tokenizer download failed (${response.status}).`);
      return response.json();
    }),
    fetch(TOKENIZER_CONFIG_URL).then(async (response) => {
      if (!response.ok) throw new Error(`Tokenizer configuration download failed (${response.status}).`);
      return response.json();
    }),
    ort.InferenceSession.create(MODEL_URL, {
      executionProviders: hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
    }),
  ]).then(([tokenizerJson, tokenizerConfig, loadedSession]) => {
    tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    session = loadedSession;
    if (!session.inputNames.includes('input_ids') || !session.inputNames.includes('attention_mask') || !session.inputNames.includes('position_ids')) {
      throw new Error(`Unexpected Qwen3 inputs: ${session.inputNames.join(', ')}`);
    }
    getElement<HTMLElement>('#load-time').textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;
    setStatus(`Model ready. ${session.inputNames.length} inputs and ${session.outputNames.length} outputs detected.`);
  }).catch((error: unknown) => {
    loadPromise = undefined;
    throw error;
  });
  return loadPromise;
}

function tensor(type: ort.Tensor.Type, data: ort.Tensor.DataType, dims: readonly number[]): ort.Tensor {
  return new ort.Tensor(type, data, dims);
}

function int64(values: number[], dims: readonly number[]): ort.Tensor {
  return tensor('int64', BigInt64Array.from(values, BigInt), dims);
}

function emptyCache(name: string): ort.Tensor {
  // Qwen3-0.6B has eight key/value heads, each with a head width of 128.
  const values = new Uint16Array(0);
  return tensor('float16', values, [1, 8, 0, 128]);
}

function getNextToken(logits: ort.Tensor): number {
  const vocabularySize = logits.dims.at(-1) ?? 0;
  const values = logits.data as Float32Array | Uint16Array;
  const offset = values.length - vocabularySize;
  let bestToken = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let tokenId = 0; tokenId < vocabularySize; tokenId += 1) {
    const value = values[offset + tokenId];
    if (value > bestValue) {
      bestValue = value;
      bestToken = tokenId;
    }
  }
  return bestToken;
}

function findLogits(outputs: TensorMap): ort.Tensor {
  const logitsName = session?.outputNames.find((name) => name === 'logits' || name.endsWith('.logits'));
  const logits = logitsName ? outputs[logitsName] : undefined;
  if (!logits) throw new Error(`The model did not return logits. Outputs: ${Object.keys(outputs).join(', ')}`);
  return logits;
}

function buildFeeds(inputIds: number[], position: number, cache: TensorMap | undefined): TensorMap {
  if (!session) throw new Error('The ONNX Runtime Web session is not loaded.');
  const feeds: TensorMap = {
    input_ids: int64(inputIds, [1, inputIds.length]),
    attention_mask: int64(Array.from({ length: position + inputIds.length }, () => 1), [1, position + inputIds.length]),
    position_ids: int64(Array.from({ length: inputIds.length }, (_, index) => position + index), [1, inputIds.length]),
  };
  for (const name of session.inputNames.filter((inputName) => inputName.startsWith('past_key_values.'))) {
    feeds[name] = cache?.[name] ?? emptyCache(name);
  }
  return feeds;
}

async function generate(prompt: string, onToken: (text: string) => void): Promise<{ text: string; tokens: number }> {
  if (!session || !tokenizer) throw new Error('The model is not loaded.');
  // Qwen3 uses this empty thinking block when thinking is disabled. This is
  // the direct-tokenizer equivalent of Transformers.js enable_thinking=false.
  const formattedPrompt = `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
  const encoded = tokenizer.encode(formattedPrompt);
  let generated: number[] = [];
  let cache: TensorMap | undefined;
  let position = 0;
  for (let step = 0; step < MAX_NEW_TOKENS; step += 1) {
    const inputIds = step === 0 ? encoded.ids : [generated.at(-1) as number];
    const outputs = await session.run(buildFeeds(inputIds, position, cache));
    const nextToken = getNextToken(findLogits(outputs));
    cache = Object.fromEntries(Object.entries(outputs).filter(([name]) => name.startsWith('present.')).map(([name, value]) => [name.replace('present', 'past_key_values'), value]));
    generated.push(nextToken);
    position += inputIds.length;
    if (nextToken === EOS_TOKEN_ID) break;
    const decoded = tokenizer.decode(generated, { skip_special_tokens: true });
    onToken(decoded);
  }
  return { text: tokenizer.decode(generated, { skip_special_tokens: true }).trim(), tokens: generated.length };
}

button.addEventListener('click', async () => {
  button.disabled = true;
  button.innerHTML = 'Working… <span class="spinner"></span>';
  output.classList.remove('placeholder');
  output.textContent = '';
  const totalStartedAt = performance.now();
  try {
    await loadModel();
    setStatus('Model is ready. Running greedy decoding…');
    const generationStartedAt = performance.now();
    const result = await generate(getElement<HTMLTextAreaElement>('#prompt').value, (text) => { output.textContent = text; });
    const generationSeconds = (performance.now() - generationStartedAt) / 1000;
    output.textContent = result.text || 'The model returned an empty answer.';
    getElement<HTMLElement>('#generation-time').textContent = `${generationSeconds.toFixed(2)} s`;
    getElement<HTMLElement>('#speed').textContent = `${(result.tokens / generationSeconds).toFixed(1)} tokens/s`;
    setStatus(`Complete in ${((performance.now() - totalStartedAt) / 1000).toFixed(1)} s.`);
  } catch (error: unknown) {
    console.error(error);
    output.textContent = 'The experiment could not start. Check the browser console for details.';
    setStatus(`Error: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Run inference again <span>↗</span>';
  }
});
