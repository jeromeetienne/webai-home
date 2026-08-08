import { env, pipeline, TextStreamer, InterruptableStoppingCriteria, type TextGenerationPipeline } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Usage metadata de-risk gate for issue #150, milestone 0, Qwen3.5-0.8B row
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Same pinned identifiers as packages/worker_webpage/web/src/stages/stage_helper_llm_qwen3_5_0_8b_full.ts,
// so this gate proves the same model configuration the real stage runs, not a stand-in.
const MODEL_ID = 'onnx-community/Qwen3.5-0.8B-ONNX';
const MODEL_REVISION = 'c0d619322dad7c4441a8841a53fc59772ddddcc0';
const MODEL_DTYPE = 'q4f16';

type CacheEntry = { body: ArrayBuffer; headers: Record<string, string>; status: number };
type ProgressCallback = (progress: { loaded: number; total: number; progress: number }) => void;
type IndexedDbCache = { match: (key: string) => Promise<Response | undefined>; put: (key: string, response: Response, progressCallback?: ProgressCallback) => Promise<void> };

env.allowLocalModels = false;

// Same IndexedDB cache as packages/_onnx_experiments/public/qwen3_5-0.8b-gate/src/main.ts, same database
// name, so a browser that already ran that gate does not re-download the model for this one.
function createIndexedDbCache(): IndexedDbCache | null {
	if (typeof indexedDB === 'undefined' || typeof Response === 'undefined') { return null; }
	const databaseName = 'webai-onnx-experiments';
	const storeName = 'model-files';
	let databasePromise: Promise<IDBDatabase> | undefined;
	function openDatabase() {
		if (databasePromise === undefined) {
			databasePromise = new Promise((resolve, reject) => {
				const request = indexedDB.open(databaseName, 1);
				request.onupgradeneeded = () => request.result.createObjectStore(storeName);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		}
		return databasePromise;
	}
	async function read(key: string): Promise<CacheEntry | undefined> {
		const database = await openDatabase();
		return new Promise((resolve, reject) => {
			const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}
	async function write(key: string, value: CacheEntry): Promise<void> {
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
				if (entry === undefined) { return undefined; }
				return new Response(entry.body, { status: entry.status, headers: entry.headers });
			} catch (error) {
				console.warn('Unable to read the IndexedDB model cache:', error);
				return undefined;
			}
		},
		async put(key, response, progressCallback) {
			try {
				const body = await response.arrayBuffer();
				const headers: Record<string, string> = {};
				response.headers.forEach((value, headerName) => { headers[headerName] = value; });
				await write(key, { body, headers, status: response.status });
				progressCallback?.({ loaded: body.byteLength, total: body.byteLength, progress: 100 });
			} catch (error) {
				console.warn('Unable to write the IndexedDB model cache:', error);
			}
		},
	};
}
const indexedDbCache = createIndexedDbCache();
if (indexedDbCache !== null) {
	env.useBrowserCache = false;
	env.useCustomCache = true;
	env.customCache = indexedDbCache;
} else {
	env.useBrowserCache = true;
}

const buttonElement = document.querySelector<HTMLButtonElement>('#run-button');
const outputElement = document.querySelector<HTMLElement>('#output');
if (buttonElement === null || outputElement === null) { throw new Error('The page must contain #run-button and #output.'); }
// Re-bound to a definitely-non-null type: log() and loadedGenerator() below are closures declared later in this
// module, and TypeScript does not carry the null-check above through a closure boundary on its own.
const button: HTMLButtonElement = buttonElement;
const output: HTMLElement = outputElement;

function log(message: string, className?: string): void {
	const line = document.createElement('div');
	if (className !== undefined) { line.className = className; }
	line.textContent = message;
	output.appendChild(line);
	console.log(message);
}

let generatorPromise: Promise<TextGenerationPipeline> | undefined;
function loadedGenerator(): Promise<TextGenerationPipeline> {
	if (generatorPromise !== undefined) { return generatorPromise; }
	generatorPromise = pipeline('text-generation', MODEL_ID, {
		revision: MODEL_REVISION,
		device: 'webgpu',
		dtype: MODEL_DTYPE,
		progress_callback: (progress: { status: string; file?: string; progress?: number }) => {
			if (progress.status === 'progress' && progress.file !== undefined) {
				const percent = Number.isFinite(progress.progress) ? ` ${Math.round(progress.progress ?? 0)}%` : '';
				button.textContent = `Downloading ${progress.file}${percent}…`;
			}
		},
	});
	return generatorPromise;
}

/** One generation run, instrumented to capture raw token ids as they are produced. */
async function runGeneration(
	generator: TextGenerationPipeline,
	prompt: string,
	maxNewTokens: number,
	onToken?: (tokenIds: number[]) => void,
): Promise<{ text: string; tokenIds: number[]; criteria: InterruptableStoppingCriteria; wallMs: number }> {
	const tokenIds: number[] = [];
	let text = '';
	const criteria = new InterruptableStoppingCriteria();
	const streamer = new TextStreamer(generator.tokenizer, {
		skip_prompt: true,
		skip_special_tokens: true,
		// The real stage helper (stage_helper_llm_qwen3_5_0_8b_full.ts, createGenerationStream) builds the
		// answer from these decoded chunks, never from generator()'s own return value — a chat-style input
		// makes that return value an array of message objects, not a string.
		callback_function: (chunk: string) => {
			text += chunk;
		},
		token_callback_function: (newTokens: bigint[]) => {
			const asNumbers = newTokens.map((tokenId) => Number(tokenId));
			tokenIds.push(...asNumbers);
			onToken?.(asNumbers);
		},
	});
	const startedAt = performance.now();
	await generator([{ role: 'user', content: prompt }], {
		max_new_tokens: maxNewTokens,
		do_sample: false,
		return_full_text: false,
		tokenizer_encode_kwargs: { enable_thinking: false },
		stopping_criteria: criteria,
		streamer,
	});
	const wallMs = performance.now() - startedAt;
	return { text, tokenIds, criteria, wallMs };
}

button.addEventListener('click', async () => {
	button.disabled = true;
	output.textContent = '';
	try {
		log('Loading model…', 'phase');
		const generator = await loadedGenerator();
		log('Model loaded. Raw tokenizer and model objects:');
		log(`  generator.tokenizer.constructor.name = ${generator.tokenizer.constructor.name}`);
		const genConfig = (generator.model as unknown as { generation_config?: { eos_token_id?: unknown } }).generation_config;
		log(`  generator.model.generation_config.eos_token_id = ${JSON.stringify(genConfig?.eos_token_id)}`);
		const eosIds = genConfig?.eos_token_id;
		const eosArray = Array.isArray(eosIds) ? eosIds : eosIds === undefined ? [] : [eosIds];

		// Phase 1 — exact tokenizer count for a plain prompt string, the way `payload.text` arrives.
		log('', undefined);
		log('Phase 1 — tokenizer count for a prompt string', 'phase');
		const testPrompt = 'Name the largest planet in the solar system, in one short sentence.';
		const encoded = generator.tokenizer(testPrompt) as unknown as { input_ids: { dims?: number[]; data?: ArrayLike<number> } };
		log(`  tokenizer(prompt) raw shape: ${JSON.stringify({ dims: encoded.input_ids.dims, dataLength: encoded.input_ids.data?.length })}`);
		const rawTokenIds = encoded.input_ids.data !== undefined ? Array.from(encoded.input_ids.data, (value) => Number(value)) : [];
		log(`  raw prompt token ids: ${JSON.stringify(rawTokenIds)}`);
		log(`  prompt token count (tokenizer, no chat template) = ${rawTokenIds.length}`);
		// return_dict: false makes apply_chat_template hand back the input_ids Tensor directly, the same
		// shape generator.tokenizer(testPrompt) returned above, instead of a {input_ids, attention_mask} dict.
		const withTemplate = (
			generator.tokenizer as unknown as {
				apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => { dims?: number[]; data?: ArrayLike<number> };
			}
		).apply_chat_template([{ role: 'user', content: testPrompt }], {
			tokenize: true,
			add_generation_prompt: true,
			enable_thinking: false,
			return_dict: false,
		});
		log(`  chat-template tensor raw shape: ${JSON.stringify({ dims: withTemplate.dims, dataLength: withTemplate.data?.length })}`);
		log(`  prompt token count (chat template applied, what generate() actually feeds the model) = ${withTemplate.data?.length ?? 'unknown'}`);

		// Phase 2 — natural stop at the end-of-sequence token, generous cap.
		log('', undefined);
		log('Phase 2 — natural end-of-sequence stop (max_new_tokens = 200)', 'phase');
		const phase2 = await runGeneration(generator, testPrompt, 200);
		const phase2Last = phase2.tokenIds.at(-1);
		log(`  generated ${phase2.tokenIds.length} tokens in ${phase2.wallMs.toFixed(0)} ms`);
		log(`  criteria.interrupted = ${phase2.criteria.interrupted}`);
		log(`  last generated token id = ${phase2Last}, is in eos_token_id set = ${eosArray.includes(phase2Last as number)}`);
		log(`  reached the max_new_tokens cap (200) = ${phase2.tokenIds.length >= 200}`);
		log(`  answer: ${JSON.stringify(phase2.text)}`);

		// Phase 3 — force the max_new_tokens cap with a prompt that has much more to say.
		log('', undefined);
		log('Phase 3 — forced max_new_tokens cap (max_new_tokens = 5)', 'phase');
		const longPrompt = 'Write a long, detailed description of the ocean, at least twenty sentences.';
		const phase3 = await runGeneration(generator, longPrompt, 5);
		const phase3Last = phase3.tokenIds.at(-1);
		log(`  generated ${phase3.tokenIds.length} tokens in ${phase3.wallMs.toFixed(0)} ms`);
		log(`  criteria.interrupted = ${phase3.criteria.interrupted}`);
		log(`  last generated token id = ${phase3Last}, is in eos_token_id set = ${eosArray.includes(phase3Last as number)}`);
		log(`  reached the max_new_tokens cap (5) = ${phase3.tokenIds.length >= 5}`);
		log(`  answer: ${JSON.stringify(phase3.text)}`);

		// Phase 4 — interrupt mid-generation, the same way clearGeneration/release does in the real stage.
		// Run by hand rather than through runGeneration, because interrupting requires calling
		// criteria.interrupt() from inside the token callback, the same way a real cancellation would.
		log('', undefined);
		log('Phase 4 — interrupted mid-generation (criteria.interrupt() after 3 tokens, cap = 200)', 'phase');
		let interruptRequestedAtTokenCount = -1;
		let phase4Text = '';
		const criteria4 = new InterruptableStoppingCriteria();
		const tokenIds4: number[] = [];
		const streamer4 = new TextStreamer(generator.tokenizer, {
			skip_prompt: true,
			skip_special_tokens: true,
			callback_function: (chunk: string) => {
				phase4Text += chunk;
			},
			token_callback_function: (newTokens: bigint[]) => {
				tokenIds4.push(...newTokens.map((tokenId) => Number(tokenId)));
				if (tokenIds4.length >= 3 && interruptRequestedAtTokenCount === -1) {
					interruptRequestedAtTokenCount = tokenIds4.length;
					criteria4.interrupt();
				}
			},
		});
		const phase4StartedAt = performance.now();
		await generator([{ role: 'user', content: longPrompt }], {
			max_new_tokens: 200,
			do_sample: false,
			return_full_text: false,
			tokenizer_encode_kwargs: { enable_thinking: false },
			stopping_criteria: criteria4,
			streamer: streamer4,
		});
		const phase4WallMs = performance.now() - phase4StartedAt;
		log(`  interrupt() called once ${interruptRequestedAtTokenCount} tokens had arrived`);
		log(`  generate() resolved after ${tokenIds4.length} tokens total, in ${phase4WallMs.toFixed(0)} ms`);
		log(`  criteria.interrupted = ${criteria4.interrupted}`);
		log(`  did NOT run to the 200 cap = ${tokenIds4.length < 200}`);
		log(`  answer (partial): ${JSON.stringify(phase4Text)}`);
		void phase4Text;
		void phase2;
		void phase3;

		log('', undefined);
		log('Gate complete. Copy the four phases above verbatim into the issue.', 'phase');
	} catch (error: unknown) {
		log(`FAILED: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`, 'fail');
	} finally {
		button.disabled = false;
		button.textContent = 'Run again';
	}
});

button.textContent = 'Loading model…';
void loadedGenerator().then(() => {
	button.disabled = false;
	button.textContent = 'Run gate';
}).catch((error: unknown) => {
	log(`Model failed to load: ${error instanceof Error ? error.message : String(error)}`, 'fail');
});
