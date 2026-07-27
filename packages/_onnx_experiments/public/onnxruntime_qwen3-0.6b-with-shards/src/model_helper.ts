import * as OnnxRuntimeWeb from 'onnxruntime-web';
import { Tokenizer } from '@huggingface/tokenizers';

/** Hugging Face identifier for the Qwen3 model used by this experiment. */
export const MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
/** URLs for the three independently executable ONNX model shards. */
const SHARD_URLS = [
	'/onnxruntime_qwen3-0.6b-with-shards/shards/shard-1.onnx',
	'/onnxruntime_qwen3-0.6b-with-shards/shards/shard-2.onnx',
	'/onnxruntime_qwen3-0.6b-with-shards/shards/shard-3.onnx',
] as const;
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
const MODEL_CACHE_VERSION = 2;

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

type ShardSession = OnnxRuntimeWeb.InferenceSession;

const SHARD_BOUNDARIES = [
	undefined,
	{
		normalized: '/model/layers.9/input_layernorm/output_0',
		residual: '/model/layers.9/input_layernorm/output_3',
	},
	{
		normalized: '/model/layers.19/input_layernorm/output_0',
		residual: '/model/layers.19/input_layernorm/output_3',
	},
] as const;

OnnxRuntimeWeb.env.wasm.wasmPaths = '/';
// ONNX Runtime reports provider-placement warnings through the browser's
// error console even though inference can continue. Keep only fatal runtime
// messages visible so the console does not make successful shard loading look
// like a failure.
OnnxRuntimeWeb.env.logLevel = 'fatal';

/** Provides model loading, caching, tensor handling, and text generation. */
export class ModelHelper {
	/** The final shard session, retained for the page's ready-state check. */
	static session: ShardSession | undefined;
	/** The three ordered shard sessions: input, middle, and output. */
	static shardSessions: ShardSession[] = [];
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

		const partitions = [
			{ shard: 'Shard 1', responsibility: 'Token embedding + decoder layers 0–8 + layer 9 input normalisation' },
			{ shard: 'Shard 2', responsibility: 'Decoder layers 9–18 + layer 19 input normalisation' },
			{ shard: 'Shard 3', responsibility: 'Decoder layers 19–27 + final RMSNorm + language-model output head' },
		];
		const shardLayerRows = [
			{ shard: 'Shard 1', order: 0, component: 'Token embedding' },
			...Array.from({ length: 9 }, (_, layer) => ({ shard: 'Shard 1', order: layer + 1, component: `Decoder layer ${layer}` })),
			{ shard: 'Shard 1', order: 10, component: 'Input normalisation for decoder layer 9' },
			...Array.from({ length: 10 }, (_, layer) => ({ shard: 'Shard 2', order: layer + 11, component: `Decoder layer ${layer + 9}` })),
			{ shard: 'Shard 2', order: 21, component: 'Input normalisation for decoder layer 19' },
			...Array.from({ length: 9 }, (_, layer) => ({ shard: 'Shard 3', order: layer + 22, component: `Decoder layer ${layer + 19}` })),
			{ shard: 'Shard 3', order: 31, component: 'Final normalisation' },
			{ shard: 'Shard 3', order: 32, component: 'Language-model output head' },
		];
		console.groupCollapsed(`${MODEL_ID}: three-shard pipeline`);
		console.table(partitions);
		console.table(shardLayerRows);
		console.groupCollapsed('Complete ordered model layer summary');
		console.table(layers);
		console.groupEnd();
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
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains('models')) request.result.createObjectStore('models');
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open the model cache.'));
		});
	}

	/**
	 * Reads the model bytes from IndexedDB, returning no value when unavailable.
	 *
	 * @returns A promise for the cached model bytes, or `undefined` when unavailable.
	 */
	private static async readCachedModel(cacheKey: string): Promise<ArrayBuffer | undefined> {
		try {
			const database = await ModelHelper.openModelDatabase();
			return await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
				const request = database.transaction('models', 'readonly').objectStore('models').get(cacheKey);
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
	 * @param model ONNX model file as an array buffer.
	 * @returns A promise that resolves after the cache write finishes.
	 */
	private static async cacheModel(model: ArrayBuffer, cacheKey: string): Promise<void> {
		try {
			const database = await ModelHelper.openModelDatabase();
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction('models', 'readwrite');
				transaction.objectStore('models').put(model, cacheKey);
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
	private static async fetchModelBytes(url: string, onStatus?: (message: string) => void): Promise<{ bytes: ArrayBuffer; cached: boolean }> {
		const cacheKey = url;
		const cachedModel = await ModelHelper.readCachedModel(cacheKey);
		if (cachedModel) {
			onStatus?.('cached');
			return { bytes: cachedModel, cached: true };
		}

		onStatus?.('downloading');
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
		const bytes = await response.arrayBuffer();
		await ModelHelper.cacheModel(bytes, cacheKey);
		onStatus?.('downloaded');
		return { bytes, cached: false };
	}

	/**
	 * Loads the tokenizer and creates the three ONNX Runtime Web shard sessions once per page.
	 *
	 * @param onStatus Optional callback for loading and readiness messages.
	 * @returns A promise that resolves when the tokenizer and model session are ready.
	 */
	static async loadModel(onStatus?: (message: string) => void): Promise<void> {
		if (ModelHelper.shardSessions.length === 3 && ModelHelper.tokenizer) return;
		if (ModelHelper.loadPromise) return ModelHelper.loadPromise;

		onStatus?.(`Loading the three ${MODEL_ID} shards. The first load can take a while…`);
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
			...SHARD_URLS.map((url, index) => ModelHelper.fetchModelBytes(url, (state) => onStatus?.(`Shard ${index + 1}/3 ${state}.`))),
		]).then(async ([tokenizerJson, tokenizerConfig, ...shards]) => {
			ModelHelper.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
			const sessions: ShardSession[] = [];
			for (const [index, shard] of shards.entries()) {
				onStatus?.(`Compiling shard ${index + 1}/3…`);
				sessions.push(await OnnxRuntimeWeb.InferenceSession.create(shard.bytes, {
					executionProviders: hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'],
					graphOptimizationLevel: 'all',
				}));
			}
			ModelHelper.shardSessions = sessions;
			ModelHelper.session = ModelHelper.shardSessions[2];
			for (const [index, session] of ModelHelper.shardSessions.entries()) {
				if (!session.inputNames.includes('attention_mask') || !session.inputNames.includes('position_ids')) {
					throw new Error(`Unexpected Qwen3 shard ${index + 1} inputs: ${session.inputNames.join(', ')}`);
				}
			}
			const cachedCount = shards.filter((shard) => shard.cached).length;
			onStatus?.(`${cachedCount === 3 ? 'Cached shards' : 'Three shards loaded and cached'} ready. The pipeline has 3 independent sessions.`);
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
	private static findLogits(session: ShardSession, outputs: TensorMap): OnnxRuntimeWeb.Tensor {
		const logitsName = session.outputNames.find((name) => name === 'logits' || name.endsWith('.logits'));
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
	private static buildFeeds(session: ShardSession, inputIds: number[], position: number, cache: TensorMap | undefined, boundary?: TensorMap): TensorMap {
		const feeds: TensorMap = {
			input_ids: ModelHelper.int64(inputIds, [1, inputIds.length]),
			attention_mask: ModelHelper.int64(Array.from({ length: position + inputIds.length }, () => 1), [1, position + inputIds.length]),
			position_ids: ModelHelper.int64(Array.from({ length: inputIds.length }, (_, index) => position + index), [1, inputIds.length]),
		};
		if (boundary) {
			for (const name of Object.keys(boundary)) feeds[name] = boundary[name];
		}
		for (const name of session.inputNames.filter((inputName) => inputName.startsWith('past_key_values.'))) {
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
		if (ModelHelper.shardSessions.length !== 3 || !ModelHelper.tokenizer) throw new Error('The three model shards are not loaded.');
		const formattedPrompt = `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
		const encoded = ModelHelper.tokenizer.encode(formattedPrompt);
		const generated: number[] = [];
		const caches: Array<TensorMap | undefined> = [undefined, undefined, undefined];
		let position = 0;
		for (let step = 0; step < MAX_NEW_TOKENS; step += 1) {
			const inputIds = step === 0 ? encoded.ids : [generated.at(-1) as number];
			let boundary: TensorMap | undefined;
			for (const [index, session] of ModelHelper.shardSessions.entries()) {
				const outputs = await session.run(ModelHelper.buildFeeds(session, inputIds, position, caches[index], boundary));
				caches[index] = Object.fromEntries(Object.entries(outputs)
					.filter(([name]) => name.startsWith('present.'))
					.map(([name, value]) => [name.replace('present', 'past_key_values'), value]));
				if (index < 2) {
					const boundaryNames = SHARD_BOUNDARIES[index + 1];
					if (!boundaryNames) throw new Error(`Missing boundary definition after shard ${index + 1}.`);
					boundary = {
						[boundaryNames.normalized]: outputs[boundaryNames.normalized],
						[boundaryNames.residual]: outputs[boundaryNames.residual],
					};
				}
				if (index === 2) {
					const nextToken = ModelHelper.getNextToken(ModelHelper.findLogits(session, outputs));
					generated.push(nextToken);
					if (nextToken === EOS_TOKEN_ID) break;
					onToken(ModelHelper.tokenizer.decode(generated, { skip_special_tokens: true }));
				}
			}
			position += inputIds.length;
		}
		return { text: ModelHelper.tokenizer.decode(generated, { skip_special_tokens: true }).trim(), tokens: generated.length };
	}
}
