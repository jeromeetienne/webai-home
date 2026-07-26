import { pipeline, env } from '@huggingface/transformers';
import './styles.css';

env.allowLocalModels = false;
// Qwen's graph produces expected provider-assignment warnings during startup.
// Keep actionable runtime errors visible without filling the browser console.
function configureOnnxLogging() {
  if (document.body.dataset.model === 'qwen') {
    env.backends.onnx.logLevel = 'error';
  }
}

configureOnnxLogging();

const indexedDbCache = createIndexedDbCache();
if (indexedDbCache) {
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = indexedDbCache;
} else {
  // Keep the existing persistent cache as a fallback for browsers where
  // IndexedDB is unavailable or disabled.
  env.useBrowserCache = true;
}

function createIndexedDbCache() {
  if (typeof indexedDB === 'undefined' || typeof Response === 'undefined') return null;

  const databaseName = 'webai-onnx-experiments';
  const storeName = 'model-files';
  let databasePromise;

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(storeName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return databasePromise;
  }

  async function read(key) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function write(key, value) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  return {
    async match(key) {
      try {
        const entry = await read(key);
        if (!entry) return undefined;
        return new Response(entry.body, {
          status: entry.status,
          headers: entry.headers,
        });
      } catch (error) {
        console.warn('Unable to read the IndexedDB model cache:', error);
        return undefined;
      }
    },

    async put(key, response, progressCallback) {
      try {
        const body = await response.arrayBuffer();
        const headers = Object.fromEntries(response.headers.entries());
        await write(key, {
          body,
          headers,
          status: response.status,
        });
        progressCallback?.({ loaded: body.byteLength, total: body.byteLength, progress: 100 });
      } catch (error) {
        console.warn('Unable to write the IndexedDB model cache:', error);
      }
    },
  };
}

const models = {
  qwen: {
    shortName: 'Qwen2.5',
    fullName: 'Qwen2.5-0.5B-Instruct',
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    accent: 'amber',
    prompt: 'Explain in two short sentences why running a language model in the browser can be useful.',
  },
  smollm: {
    shortName: 'SmolLM2',
    fullName: 'SmolLM2-360M-Instruct',
    id: 'eduardoworrel/SmolLM2-360M-Instruct',
    accent: 'blue',
    prompt: 'Explain in two short sentences why running a language model in the browser can be useful.',
  },
};

const model = models[document.body.dataset.model];
let generator;
let loadStartedAt;
let modelLoadPromise;

document.querySelector('#app').innerHTML = `
  <main class="shell experiment-shell ${model.accent}">
    <header class="topbar">
      <a class="back-link" href="./">← All experiments</a>
      <span class="runtime-pill"><i></i><span id="runtime-label">Checking runtime</span></span>
    </header>
    <section class="hero">
      <p class="eyebrow">Browser inference / field test ${model.accent === 'amber' ? '01' : '02'}</p>
      <h1>${model.shortName}<br /><em>${model.fullName}</em></h1>
      <p class="intro">A compact ONNX language model running locally in this browser. Load it once, then measure a real generation on your device.</p>
    </section>
    <section class="test-panel" aria-labelledby="test-heading">
      <div class="panel-heading">
        <div><p class="section-label">Test prompt</p><h2 id="test-heading">A small question, a useful answer.</h2></div>
        <span class="model-tag">${model.id}</span>
      </div>
      <label class="sr-only" for="prompt">Prompt</label>
      <textarea id="prompt" rows="3">${model.prompt}</textarea>
      <div class="controls">
        <button id="run-button" class="primary-button" type="button">Load model &amp; run inference <span>↗</span></button>
        <span class="hint">48 new tokens · greedy decode</span>
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
    <p id="status" class="status">Ready. The first run downloads the ONNX weights; later page loads use IndexedDB.</p>
    <footer><span>ONNX Runtime Web + Transformers.js</span><span>Local inference · no prompt upload</span></footer>
  </main>
`;

const button = document.querySelector('#run-button');
const status = document.querySelector('#status');
const output = document.querySelector('#output');
const runtimeLabel = document.querySelector('#runtime-label');
const backend = document.querySelector('#backend');

const hasWebGPU = 'gpu' in navigator;
runtimeLabel.textContent = hasWebGPU ? 'WebGPU available' : 'WebAssembly fallback';
backend.textContent = hasWebGPU ? 'WebGPU' : 'WebAssembly';

function setStatus(message) {
  status.textContent = message;
}

function getText(result) {
  const generated = result?.[0]?.generated_text;
  if (Array.isArray(generated)) return generated.at(-1)?.content ?? '';
  return typeof generated === 'string' ? generated : '';
}

function loadModel() {
  if (generator) return Promise.resolve(generator);
  if (modelLoadPromise) return modelLoadPromise;

  // Reapply this immediately before session creation. ONNX Runtime reads the
  // setting when its WebAssembly runtime starts, not when the page is built.
  configureOnnxLogging();
  setStatus(`Downloading ${model.fullName}. This can take a while on the first run…`);
  loadStartedAt = performance.now();
  modelLoadPromise = pipeline('text-generation', model.id, {
    device: hasWebGPU ? 'webgpu' : 'wasm',
    // The SmolLM2 ONNX graph expects float32 inputs. q4 keeps the
    // quantised weights while avoiding the float16 input mismatch.
    dtype: 'q4',
    progress_callback: (progress) => {
      if (progress?.status === 'progress' && progress.file) {
        const percent = Number.isFinite(progress.progress) ? ` ${Math.round(progress.progress)}%` : '';
        setStatus(`Downloading ${progress.file}${percent}…`);
      }
    },
  }).then((loadedGenerator) => {
    generator = loadedGenerator;
    document.querySelector('#load-time').textContent = `${((performance.now() - loadStartedAt) / 1000).toFixed(1)} s`;
    setStatus('Model ready. Enter a prompt and run inference.');
    button.disabled = false;
    button.innerHTML = 'Run inference <span>↗</span>';
    return loadedGenerator;
  }).catch((error) => {
    modelLoadPromise = undefined;
    button.disabled = false;
    button.innerHTML = 'Load model &amp; run inference <span>↗</span>';
    throw error;
  });

  return modelLoadPromise;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  button.innerHTML = 'Working… <span class="spinner"></span>';
  output.classList.remove('placeholder');
  output.textContent = '';
  const totalStartedAt = performance.now();
  try {
    const loadedGenerator = await loadModel();
    setStatus('Model is ready. Running inference…');

    const generationStartedAt = performance.now();
    const result = await loadedGenerator([{ role: 'user', content: document.querySelector('#prompt').value }], {
      max_new_tokens: 48,
      do_sample: false,
      return_full_text: false,
    });
    const generationMs = performance.now() - generationStartedAt;
    const answer = getText(result).trim();
    const tokenCount = Math.max(1, answer.split(/\s+/).length);
    output.textContent = answer || 'The model returned an empty answer.';
    document.querySelector('#generation-time').textContent = `${(generationMs / 1000).toFixed(2)} s`;
    document.querySelector('#speed').textContent = `${(tokenCount / (generationMs / 1000)).toFixed(1)} words/s`;
      setStatus(`Complete in ${((performance.now() - totalStartedAt) / 1000).toFixed(1)} s. Model files remain in IndexedDB for later page loads.`);
  } catch (error) {
    console.error(error);
    output.textContent = 'The experiment could not start. Check the browser console for details.';
    setStatus(`Error: ${error?.message ?? 'unknown error'}`);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Run inference again <span>↗</span>';
  }
});

button.disabled = true;
button.innerHTML = 'Loading model… <span class="spinner"></span>';
void loadModel().catch((error) => {
  console.error(error);
  setStatus(`Unable to load ${model.fullName}: ${error?.message ?? 'unknown error'}`);
});
