import { MODEL_ID, ModelHelper } from './model_helper';
import { UiHelper } from './ui_helper';


/** Builds the page, connects the user interface to the model, and starts loading. */
class MainHelper {
	/**
	 * Builds the Qwen3 experiment page and starts loading the model.
	 *
	 * @returns A promise that resolves after the page handlers and initial load have been started.
	 */
	static async main(): Promise<void> {
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
      <h1>Qwen3<br /><em>onnxruntime_qwen3-0.6b-with-shards</em></h1>
    <p class="intro">Qwen3-0.6B-ONNX running as three explicit layer shards through ONNX Runtime Web. Each shard has its own session and passes activations to the next shard.</p>
    </section>
    <section class="test-panel" aria-labelledby="test-heading">
      <div class="panel-heading">
        <div><p class="section-label">Test prompt</p><h2 id="test-heading">A small question, a useful answer.</h2></div>
        <span class="model-tag">${MODEL_ID} · 3 ONNX shards</span>
      </div>
      <label class="sr-only" for="prompt">Prompt</label>
      <textarea id="prompt" rows="3">Explain in two short sentences why running a language model in the browser can be useful.</textarea>
      <div class="controls">
        <button id="run-button" class="primary-button" type="button" disabled>Loading model… <span class="spinner"></span></button>
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
    <p id="status" class="status">Ready. The first run downloads the three quantized ONNX shards.</p>
    <footer><span>ONNX Runtime Web + Hugging Face Tokenizers</span><span>Local inference · no prompt upload</span></footer>
  </main>
`;

		const button = UiHelper.getElement<HTMLButtonElement>('#run-button');
		const output = UiHelper.getElement<HTMLElement>('#output');
		const runtimeLabel = UiHelper.getElement<HTMLElement>('#runtime-label');
		const backend = UiHelper.getElement<HTMLElement>('#backend');
		const hasWebGPU = 'gpu' in navigator;
		runtimeLabel.textContent = hasWebGPU ? 'WebGPU available' : 'WebAssembly fallback';
		backend.textContent = hasWebGPU ? 'WebGPU' : 'WebAssembly';

		ModelHelper.logLayerSummary();

		button.addEventListener('click', async () => {
			button.disabled = true;
			button.innerHTML = 'Working… <span class="spinner"></span>';
			output.classList.remove('placeholder');
			output.textContent = '';
			const totalStartedAt = performance.now();
			try {
				await ModelHelper.loadModel(UiHelper.setStatus);
				UiHelper.setStatus('Model is ready. Running greedy decoding…');
				const generationStartedAt = performance.now();
				const result = await ModelHelper.generate(UiHelper.getElement<HTMLTextAreaElement>('#prompt').value, (text) => { output.textContent = text; });
				const generationSeconds = (performance.now() - generationStartedAt) / 1000;
				output.textContent = result.text || 'The model returned an empty answer.';
				UiHelper.getElement<HTMLElement>('#generation-time').textContent = `${generationSeconds.toFixed(2)} s`;
				UiHelper.getElement<HTMLElement>('#speed').textContent = `${(result.tokens / generationSeconds).toFixed(1)} tokens/s`;
				UiHelper.setStatus(`Complete in ${((performance.now() - totalStartedAt) / 1000).toFixed(1)} s.`);
			} catch (error: unknown) {
				console.error(error);
				output.textContent = 'The experiment could not start. Check the browser console for details.';
				UiHelper.setStatus(`Error: ${error instanceof Error ? error.message : 'unknown error'}`);
			} finally {
				button.disabled = !ModelHelper.session || !ModelHelper.tokenizer;
				button.innerHTML = ModelHelper.session && ModelHelper.tokenizer
					? 'Run inference again <span>↗</span>'
					: 'Retry loading model <span>↗</span>';
			}
		});

		const modelLoadStartedAt = performance.now();
		void ModelHelper.loadModel(UiHelper.setStatus).then(() => {
			UiHelper.getElement<HTMLElement>('#load-time').textContent = `${((performance.now() - modelLoadStartedAt) / 1000).toFixed(1)} s`;
			button.disabled = false;
			button.innerHTML = 'Run inference <span>↗</span>';
		}).catch((error: unknown) => {
			console.error(error);
			output.textContent = 'The model could not be loaded. Check the browser console for details.';
			UiHelper.setStatus(`Error: ${error instanceof Error ? error.message : 'unknown error'}`);
			button.disabled = false;
			button.innerHTML = 'Retry loading model <span>↗</span>';
		});
	}
}


///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void MainHelper.main();
