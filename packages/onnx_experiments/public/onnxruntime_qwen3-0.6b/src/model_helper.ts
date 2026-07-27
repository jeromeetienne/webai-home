import * as OnnxRuntimeWeb from 'onnxruntime-web';
import { Tokenizer } from '@huggingface/tokenizers';

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
/** Maximum number of new tokens generated for one prompt. */
const MAX_NEW_TOKENS = 160;
/** IndexedDB database name for the downloaded model. */
const MODEL_CACHE_NAME = 'onnxruntime-qwen3-models';
/** IndexedDB schema version for the model cache. */
const MODEL_CACHE_VERSION = 1;
/** IndexedDB key derived from the model URL. */
const MODEL_CACHE_KEY = MODEL_URL;

/** Static architecture values used by the console layer summary and cache-shape helpers. */
const qwen3Config = {
	layers: 28,
	hiddenSize: 1024,
	intermediateSize: 3072,
	attentionHeads: 16,
	keyValueHeads: 8,
	headDim: 128,
	activation: 'SiLU gated feed-forward network',
	normalization: 'RMSNorm (epsilon 1e-6)',
};

/** The named tensors passed to and returned from the ONNX model. */
type TensorMap = Record<string, OnnxRuntimeWeb.Tensor>;

OnnxRuntimeWeb.env.wasm.wasmPaths = '/';
OnnxRuntimeWeb.env.logLevel = 'error';

/** Provides model loading, caching, tensor handling, and text generation. */
export class ModelHelper {
	/** Active ONNX Runtime Web session, once the model has loaded. */
	static session: OnnxRuntimeWeb.InferenceSession | undefined;
	/** Tokenizer instance, once tokenizer data has loaded. */
	static tokenizer: Tokenizer | undefined;
	/** Shared promise that prevents concurrent model loads. */
	static loadPromise: Promise<void> | undefined;

	/**
	 * Prints the complete ordered Qwen3 model stack to the browser console.
	 *
	 * @returns Nothing. The summary is written to the browser console.
	 */
	static logLayerSummary(): void {
		const layers = [
			{ order: 0, type: 'embedding', name: 'Token embedding', details: `vocabulary → ${qwen3Config.hiddenSize}` },
			...Array.from({ length: qwen3Config.layers }, (_, layer) => ({
				order: layer + 1,
				type: 'transformer decoder',
				name: `Decoder layer ${layer}`,
				details: `${qwen3Config.attentionHeads} attention heads, ${qwen3Config.keyValueHeads} key-value heads, ${qwen3Config.intermediateSize} feed-forward size`,
				hiddenSize: qwen3Config.hiddenSize,
				headDim: qwen3Config.headDim,
				activation: qwen3Config.activation,
				normalization: qwen3Config.normalization,
				kvCache: `[1, ${qwen3Config.keyValueHeads}, sequence, ${qwen3Config.headDim}]`,
			})),
			{ order: qwen3Config.layers + 1, type: 'normalization', name: 'Final RMSNorm', details: `hidden size ${qwen3Config.hiddenSize}, epsilon 1e-6` },
			{ order: qwen3Config.layers + 2, type: 'output head', name: 'Language-model head', details: `hidden size ${qwen3Config.hiddenSize} → vocabulary` },
		];

		console.groupCollapsed(`${MODEL_ID}: complete ordered model layer summary`);
		console.table(layers);
		console.groupEnd();
	}

	/**
	 * Opens the IndexedDB database used to store the downloaded ONNX model.
	 *
	 * @returns A promise for the opened IndexedDB database.
	 */
	private static openModelDatabase(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(MODEL_CACHE_NAME, MODEL_CACHE_VERSION);
			request.onupgradeneeded = () => request.result.createObjectStore('models');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open the model cache.'));
		});
	}

	/**
	 * Reads the model bytes from IndexedDB, returning no value when unavailable.
	 *
	 * @returns A promise for the cached model bytes, or `undefined` when unavailable.
	 */
	private static async readCachedModel(): Promise<ArrayBuffer | undefined> {
		try {
			const database = await ModelHelper.openModelDatabase();
			return await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
				const request = database.transaction('models', 'readonly').objectStore('models').get(MODEL_CACHE_KEY);
				request.onsuccess = () => resolve(request.result as ArrayBuffer | undefined);
				request.onerror = () => reject(request.error ?? new Error('Could not read the model cache.'));
			}).finally(() => database.close());
		} catch (error) {
			console.warn('The cached model could not be read. Loading a fresh copy instead.', error);
			return undefined;
		}
	}

	/**
	 * Stores the downloaded model bytes in IndexedDB for later page loads.
	 *
	 * @param model Complete ONNX model file as an array buffer.
	 * @returns A promise that resolves after the cache write finishes.
	 */
	private static async cacheModel(model: ArrayBuffer): Promise<void> {
		try {
			const database = await ModelHelper.openModelDatabase();
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction('models', 'readwrite');
				transaction.objectStore('models').put(model, MODEL_CACHE_KEY);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error ?? new Error('Could not write the model cache.'));
			}).finally(() => database.close());
		} catch (error) {
			console.warn('The model loaded, but could not be cached in IndexedDB.', error);
		}
	}

	/**
	 * Returns model bytes from IndexedDB or downloads and caches a fresh copy.
	 *
	 * @returns A promise containing the model bytes and cache source information.
	 */
	private static async fetchModelBytes(): Promise<{ bytes: ArrayBuffer; cached: boolean }> {
		const cachedModel = await ModelHelper.readCachedModel();
		if (cachedModel) return { bytes: cachedModel, cached: true };

		const response = await fetch(MODEL_URL);
		if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
		const bytes = await response.arrayBuffer();
		await ModelHelper.cacheModel(bytes);
		return { bytes, cached: false };
	}

	/**
	 * Loads the tokenizer and creates the ONNX Runtime Web session once per page.
	 *
	 * @param onStatus Optional callback for loading and readiness messages.
	 * @returns A promise that resolves when the tokenizer and model session are ready.
	 */
	static async loadModel(onStatus?: (message: string) => void): Promise<void> {
		if (ModelHelper.session && ModelHelper.tokenizer) return;
		if (ModelHelper.loadPromise) return ModelHelper.loadPromise;

		onStatus?.(`Loading ${MODEL_ID}. The first load can take a while…`);
		const hasWebGPU = 'gpu' in navigator;
		ModelHelper.loadPromise = Promise.all([
			fetch(TOKENIZER_URL).then(async (response) => {
				if (!response.ok) throw new Error(`Tokenizer download failed (${response.status}).`);
				return response.json();
			}),
			fetch(TOKENIZER_CONFIG_URL).then(async (response) => {
				if (!response.ok) throw new Error(`Tokenizer configuration download failed (${response.status}).`);
				return response.json();
			}),
			ModelHelper.fetchModelBytes(),
		]).then(async ([tokenizerJson, tokenizerConfig, model]) => {
			ModelHelper.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
			ModelHelper.session = await OnnxRuntimeWeb.InferenceSession.create(model.bytes, {
				executionProviders: hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'],
				graphOptimizationLevel: 'all',
			});
			if (!ModelHelper.session.inputNames.includes('input_ids') || !ModelHelper.session.inputNames.includes('attention_mask') || !ModelHelper.session.inputNames.includes('position_ids')) {
				throw new Error(`Unexpected Qwen3 inputs: ${ModelHelper.session.inputNames.join(', ')}`);
			}
			onStatus?.(`${model.cached ? 'Cached model' : 'Model downloaded and cached'} ready. ${ModelHelper.session.inputNames.length} inputs and ${ModelHelper.session.outputNames.length} outputs detected.`);
		}).catch((error: unknown) => {
			ModelHelper.loadPromise = undefined;
			throw error;
		});
		return ModelHelper.loadPromise;
	}

	/**
	 * Creates an ONNX Runtime tensor with the requested type and dimensions.
	 *
	 * @param type ONNX Runtime tensor type, such as `int64` or `float16`.
	 * @param data Typed array containing tensor values.
	 * @param dims Tensor dimensions in model order.
	 * @returns The constructed ONNX Runtime tensor.
	 */
	private static tensor(type: OnnxRuntimeWeb.Tensor.Type, data: OnnxRuntimeWeb.Tensor.DataType, dims: readonly number[]): OnnxRuntimeWeb.Tensor {
		return new OnnxRuntimeWeb.Tensor(type, data, dims);
	}

	/**
	 * Creates an int64 tensor for token and position inputs.
	 *
	 * @param values Numeric token or position values.
	 * @param dims Tensor dimensions in model order.
	 * @returns An int64 ONNX Runtime tensor.
	 */
	private static int64(values: number[], dims: readonly number[]): OnnxRuntimeWeb.Tensor {
		return ModelHelper.tensor('int64', BigInt64Array.from(values, BigInt), dims);
	}

	/**
	 * Creates the empty key-value cache expected by the first Qwen3 model call.
	 *
	 * @param name Name of the cache input; retained for call-site clarity.
	 * @returns An empty float16 key-value cache tensor.
	 */
	private static emptyCache(name: string): OnnxRuntimeWeb.Tensor {
		const values = new Uint16Array(0);
		return ModelHelper.tensor('float16', values, [1, 8, 0, 128]);
	}

	/**
	 * Selects the token with the highest logit value for greedy decoding.
	 *
	 * @param logits Output tensor containing vocabulary logits.
	 * @returns The selected vocabulary token identifier.
	 */
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

	/**
	 * Finds the logits tensor among the model outputs.
	 *
	 * @param outputs All tensors returned by the ONNX model.
	 * @returns The model's logits tensor.
	 */
	private static findLogits(outputs: TensorMap): OnnxRuntimeWeb.Tensor {
		const logitsName = ModelHelper.session?.outputNames.find((name) => name === 'logits' || name.endsWith('.logits'));
		const logits = logitsName ? outputs[logitsName] : undefined;
		if (!logits) throw new Error(`The model did not return logits. Outputs: ${Object.keys(outputs).join(', ')}`);
		return logits;
	}

	/**
	 * Builds the inputs for one model call, including the key-value cache.
	 *
	 * @param inputIds Token identifiers for the current model call.
	 * @param position Position of the first token in the current call.
	 * @param cache Key-value tensors returned by the previous model call, if any.
	 * @returns Named input tensors for ONNX Runtime.
	 */
	private static buildFeeds(inputIds: number[], position: number, cache: TensorMap | undefined): TensorMap {
		if (!ModelHelper.session) throw new Error('The ONNX Runtime Web session is not loaded.');
		const feeds: TensorMap = {
			input_ids: ModelHelper.int64(inputIds, [1, inputIds.length]),
			attention_mask: ModelHelper.int64(Array.from({ length: position + inputIds.length }, () => 1), [1, position + inputIds.length]),
			position_ids: ModelHelper.int64(Array.from({ length: inputIds.length }, (_, index) => position + index), [1, inputIds.length]),
		};
		for (const name of ModelHelper.session.inputNames.filter((inputName) => inputName.startsWith('past_key_values.'))) {
			feeds[name] = cache?.[name] ?? ModelHelper.emptyCache(name);
		}
		return feeds;
	}

	/**
	 * Generates a response using Qwen3's cached key-value tensors between steps.
	 *
	 * @param prompt User prompt to encode and complete.
	 * @param onToken Callback invoked with the progressively decoded response.
	 * @returns Generated text and the number of generated tokens.
	 */
	static async generate(prompt: string, onToken: (text: string) => void): Promise<{ text: string; tokens: number }> {
		if (!ModelHelper.session || !ModelHelper.tokenizer) throw new Error('The model is not loaded.');
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
			onToken(ModelHelper.tokenizer.decode(generated, { skip_special_tokens: true }));
		}
		return { text: ModelHelper.tokenizer.decode(generated, { skip_special_tokens: true }).trim(), tokens: generated.length };
	}
}
