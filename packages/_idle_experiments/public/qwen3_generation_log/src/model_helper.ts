import * as OnnxRuntimeWeb from 'onnxruntime-web';
import { Tokenizer } from '@huggingface/tokenizers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelHelper — loads Qwen3-0.6B-ONNX and runs one generation at a time
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Adapted from packages/_onnx_experiments/public/onnxruntime_qwen3-0.6b-plain/src/model_helper.ts,
 * trimmed to what this experiment needs: load once, then generate repeatedly with a fixed
 * prompt. Kept as its own copy rather than an import, matching how every experiment in this
 * repository — including the plain and sharded ONNX Runtime pages this was adapted from — keeps
 * its own copy of the helpers it needs instead of sharing them across experiment folders.
 */

/** Hugging Face identifier for the Qwen3 model used by this experiment. */
export const MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
/** Direct URL for the quantized ONNX model file. */
const MODEL_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/onnx/model_q4f16.onnx`;
/** Direct URL for the tokenizer vocabulary and merge configuration. */
const TOKENIZER_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer.json`;
/** Direct URL for the tokenizer settings. */
const TOKENIZER_CONFIG_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer_config.json`;
/** End-of-sequence token identifier used to stop generation. */
const EOS_TOKEN_ID = 151645;
/**
 * Maximum number of new tokens generated for one prompt.
 *
 * Kept short on purpose: this experiment cares about running many generation cycles across a
 * long, mostly-backgrounded session, so a short generation that finishes in a few seconds gives
 * more data points per minute than one long generation would.
 */
const MAX_NEW_TOKENS = 64;
/** IndexedDB database name for the downloaded model. */
const MODEL_CACHE_NAME = 'idle-experiments-qwen3-models';
/** IndexedDB schema version for the model cache. */
const MODEL_CACHE_VERSION = 1;
/** IndexedDB key derived from the model URL. */
const MODEL_CACHE_KEY = MODEL_URL;

/** The named tensors passed to and returned from the ONNX model. */
type TensorMap = Record<string, OnnxRuntimeWeb.Tensor>;

/** Which execution provider ONNX Runtime Web ended up using. */
export type ModelBackend = 'webgpu' | 'wasm';

/** One completed generation, timed and counted. */
export type GenerationResult = {
	text: string;
	tokenCount: number;
	durationMs: number;
};

OnnxRuntimeWeb.env.wasm.wasmPaths = '/';
OnnxRuntimeWeb.env.logLevel = 'error';

/** Loads the Qwen3-0.6B ONNX model once, then runs one generation at a time against it. */
export class ModelHelper {
	/** Active ONNX Runtime Web session, once the model has loaded. */
	private static session: OnnxRuntimeWeb.InferenceSession | undefined;
	/** Tokenizer instance, once tokenizer data has loaded. */
	private static tokenizer: Tokenizer | undefined;
	/** Shared promise that prevents concurrent model loads. */
	private static loadPromise: Promise<void> | undefined;
	/** Which execution provider the loaded session is using. */
	private static backend: ModelBackend = 'wasm';

	/** Reports which execution provider the loaded session is using. */
	static currentBackend(): ModelBackend {
		return ModelHelper.backend;
	}

	/**
	 * Loads the tokenizer and creates the ONNX Runtime Web session, once per page.
	 *
	 * @param onStatus Called with loading and readiness messages.
	 */
	static async loadModel(onStatus: (message: string) => void): Promise<void> {
		if (ModelHelper.session !== undefined && ModelHelper.tokenizer !== undefined) return;
		if (ModelHelper.loadPromise !== undefined) return ModelHelper.loadPromise;

		onStatus(`Loading ${MODEL_ID}. The first load downloads about 570 MB and can take a while…`);
		const hasWebGPU = 'gpu' in navigator;
		ModelHelper.backend = hasWebGPU ? 'webgpu' : 'wasm';
		ModelHelper.loadPromise = Promise.all([
			fetch(TOKENIZER_URL).then(async (response) => {
				if (response.ok === false) throw new Error(`Tokenizer download failed (${response.status}).`);
				return response.json();
			}),
			fetch(TOKENIZER_CONFIG_URL).then(async (response) => {
				if (response.ok === false) throw new Error(`Tokenizer configuration download failed (${response.status}).`);
				return response.json();
			}),
			ModelHelper.fetchModelBytes(),
		]).then(async ([tokenizerJson, tokenizerConfig, model]) => {
			ModelHelper.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
			ModelHelper.session = await OnnxRuntimeWeb.InferenceSession.create(model.bytes, {
				executionProviders: hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'],
				graphOptimizationLevel: 'all',
			});
			onStatus(`${model.cached ? 'Cached model' : 'Model downloaded and cached'} ready.`);
		}).catch((error: unknown) => {
			ModelHelper.loadPromise = undefined;
			throw error;
		});
		return ModelHelper.loadPromise;
	}

	/**
	 * Generates a response to a fixed prompt using Qwen3's cached key-value tensors between steps.
	 *
	 * @param prompt The prompt to encode and complete.
	 * @returns The generated text, how many tokens it took, and how long generation ran.
	 */
	static async generate(prompt: string): Promise<GenerationResult> {
		if (ModelHelper.session === undefined || ModelHelper.tokenizer === undefined) throw new Error('The model is not loaded.');
		const startedAt = performance.now();
		const formattedPrompt = `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
		const encoded = ModelHelper.tokenizer.encode(formattedPrompt);
		const generated: number[] = [];
		let cache: TensorMap | undefined;
		let position = 0;
		for (let step = 0; step < MAX_NEW_TOKENS; step += 1) {
			const inputIds = step === 0 ? encoded.ids : [generated.at(-1) as number];
			const outputs = await ModelHelper.session.run(ModelHelper.buildFeeds(inputIds, position, cache));
			const nextToken = ModelHelper.getNextToken(ModelHelper.findLogits(outputs));
			cache = Object.fromEntries(Object.entries(outputs).filter(([name]) => name.startsWith('present.')).map(([name, value]) => [name.replace('present', 'past_key_values'), value]));
			generated.push(nextToken);
			position += inputIds.length;
			if (nextToken === EOS_TOKEN_ID) break;
		}
		const text = ModelHelper.tokenizer.decode(generated, { skip_special_tokens: true }).trim();
		return { text, tokenCount: generated.length, durationMs: performance.now() - startedAt };
	}

	/** Opens the IndexedDB database used to store the downloaded ONNX model. */
	private static openModelDatabase(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(MODEL_CACHE_NAME, MODEL_CACHE_VERSION);
			request.onupgradeneeded = () => request.result.createObjectStore('models');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open the model cache.'));
		});
	}

	/** Reads the model bytes from IndexedDB, returning no value when unavailable. */
	private static async readCachedModel(): Promise<ArrayBuffer | undefined> {
		try {
			const database = await ModelHelper.openModelDatabase();
			return await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
				const request = database.transaction('models', 'readonly').objectStore('models').get(MODEL_CACHE_KEY);
				request.onsuccess = () => resolve(request.result as ArrayBuffer | undefined);
				request.onerror = () => reject(request.error ?? new Error('Could not read the model cache.'));
			}).finally(() => database.close());
		} catch {
			return undefined;
		}
	}

	/** Stores the downloaded model bytes in IndexedDB for later page loads. */
	private static async cacheModel(model: ArrayBuffer): Promise<void> {
		try {
			const database = await ModelHelper.openModelDatabase();
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction('models', 'readwrite');
				transaction.objectStore('models').put(model, MODEL_CACHE_KEY);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error ?? new Error('Could not write the model cache.'));
			}).finally(() => database.close());
		} catch {
			// Caching is a speed optimization only; a failed write should not block inference.
		}
	}

	/** Returns model bytes from IndexedDB or downloads and caches a fresh copy. */
	private static async fetchModelBytes(): Promise<{ bytes: ArrayBuffer; cached: boolean }> {
		const cachedModel = await ModelHelper.readCachedModel();
		if (cachedModel !== undefined) return { bytes: cachedModel, cached: true };
		const response = await fetch(MODEL_URL);
		if (response.ok === false) throw new Error(`Model download failed (${response.status}).`);
		const bytes = await response.arrayBuffer();
		await ModelHelper.cacheModel(bytes);
		return { bytes, cached: false };
	}

	/** Creates an int64 tensor for token and position inputs. */
	private static int64(values: number[], dims: readonly number[]): OnnxRuntimeWeb.Tensor {
		return new OnnxRuntimeWeb.Tensor('int64', BigInt64Array.from(values, BigInt), dims);
	}

	/** Creates the empty key-value cache expected by the first Qwen3 model call. */
	private static emptyCache(): OnnxRuntimeWeb.Tensor {
		return new OnnxRuntimeWeb.Tensor('float16', new Uint16Array(0), [1, 8, 0, 128]);
	}

	/** Selects the token with the highest logit value for greedy decoding. */
	private static getNextToken(logits: OnnxRuntimeWeb.Tensor): number {
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

	/** Finds the logits tensor among the model outputs. */
	private static findLogits(outputs: TensorMap): OnnxRuntimeWeb.Tensor {
		const logitsName = ModelHelper.session?.outputNames.find((name) => name === 'logits' || name.endsWith('.logits'));
		const logits = logitsName !== undefined ? outputs[logitsName] : undefined;
		if (logits === undefined) throw new Error(`The model did not return logits. Outputs: ${Object.keys(outputs).join(', ')}`);
		return logits;
	}

	/** Builds the inputs for one model call, including the key-value cache. */
	private static buildFeeds(inputIds: number[], position: number, cache: TensorMap | undefined): TensorMap {
		if (ModelHelper.session === undefined) throw new Error('The ONNX Runtime Web session is not loaded.');
		const feeds: TensorMap = {
			input_ids: ModelHelper.int64(inputIds, [1, inputIds.length]),
			attention_mask: ModelHelper.int64(Array.from({ length: position + inputIds.length }, () => 1), [1, position + inputIds.length]),
			position_ids: ModelHelper.int64(Array.from({ length: inputIds.length }, (_, index) => position + index), [1, inputIds.length]),
		};
		for (const name of ModelHelper.session.inputNames.filter((inputName) => inputName.startsWith('past_key_values.'))) {
			feeds[name] = cache?.[name] ?? ModelHelper.emptyCache();
		}
		return feeds;
	}
}
