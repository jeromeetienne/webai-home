import * as OnnxRuntimeWeb from "onnxruntime-web";
import { Tokenizer } from "@huggingface/tokenizers";
import { StagePayloadFactory, type EncodedTensor, type LlmStagePayload } from "@webai/protocol";
import { centralGatewayAssetUrl } from "./gateway_config";

/**
 * Adapts the proven shard-loading and tensor-handling logic from
 * packages/_onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/src/model_helper.ts
 * to run behind the real stage-assignment pipeline (see https://github.com/webai-at-home/webai-at-home/issues/9)
 * instead of one in-page button.
 *
 * One task's shards are always assigned to the same worker device. The language-model
 * pipeline states `repeatsUntilDone`, so the gateway runs its shard stages again from the
 * first once per generated token, and each of those stages states `prefersSameWorkerOnRetry`
 * so even a retried attempt comes back to the device that already holds the state. That lets
 * each shard keep its own key-value cache in this module's memory, keyed by task identifier,
 * instead of serializing it over the wire — only the small hand-off tensors between shards
 * travel inside stage.result/stage.assign.
 */

/** Hugging Face identifier for the Qwen3 model used by this experiment. */
const MODEL_ID = "onnx-community/Qwen3-0.6B-ONNX";
/** URLs for the three shards, served by the dev-only route added to packages/gateway/src/cli.ts. */
const SHARD_URLS = [
	centralGatewayAssetUrl("/onnxruntime_qwen3-0.6b-with-shards/shards/shard-1.onnx"),
	centralGatewayAssetUrl("/onnxruntime_qwen3-0.6b-with-shards/shards/shard-2.onnx"),
	centralGatewayAssetUrl("/onnxruntime_qwen3-0.6b-with-shards/shards/shard-3.onnx"),
] as const;
/** Direct URL for the tokenizer vocabulary and merge configuration. */
const TOKENIZER_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer.json`;
/** Direct URL for the tokenizer settings. */
const TOKENIZER_CONFIG_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer_config.json`;
/** IndexedDB database name for the downloaded model. */
const MODEL_CACHE_NAME = "onnxruntime-qwen3-models";
/** IndexedDB schema version for the model cache. */
const MODEL_CACHE_VERSION = 2;
/** End-of-sequence token identifier used to stop generation. */
const EOS_TOKEN_ID = 151645;
/** Maximum number of tokens generated for one task, as a safety bound if the model never emits the end-of-sequence token. */
const MAX_NEW_TOKENS = 160;

/** The named tensors passed to and returned from the ONNX model. */
type TensorMap = Record<string, OnnxRuntimeWeb.Tensor>;
type ShardSession = OnnxRuntimeWeb.InferenceSession;

const SHARD_BOUNDARIES = [
	undefined,
	{
		normalized: "/model/layers.9/input_layernorm/output_0",
		residual: "/model/layers.9/input_layernorm/output_3",
	},
	{
		normalized: "/model/layers.19/input_layernorm/output_0",
		residual: "/model/layers.19/input_layernorm/output_3",
	},
] as const;

/** Maps an ONNX Runtime tensor type to the typed-array constructor backing its data. */
const TYPED_ARRAY_BY_ONNX_TYPE: Record<string, new (buffer: ArrayBuffer) => OnnxRuntimeWeb.Tensor.DataType> = {
	float32: Float32Array,
	float64: Float64Array,
	int64: BigInt64Array as unknown as new (buffer: ArrayBuffer) => OnnxRuntimeWeb.Tensor.DataType,
	uint64: BigUint64Array as unknown as new (buffer: ArrayBuffer) => OnnxRuntimeWeb.Tensor.DataType,
	int32: Int32Array,
	uint32: Uint32Array,
	int16: Int16Array,
	uint16: Uint16Array,
	float16: Uint16Array,
	int8: Int8Array,
	uint8: Uint8Array,
	bool: Uint8Array,
};

OnnxRuntimeWeb.env.wasm.wasmPaths = "/assets/";
OnnxRuntimeWeb.env.logLevel = "fatal";

/** Per-task generation state kept in memory for as long as that task's shards run on this device. */
interface TaskGenerationState {
	/** Each shard's own key-value cache from its most recent run, reused on its next run. */
	caches: Array<TensorMap | undefined>;
	/** Token identifiers generated so far, in order. */
	generatedIds: number[];
}

/** Loads the qwen3-0.6b shards and runs the assigned shard for each stage of a task's generation loop. */
export class StageLlmHelper {
	/**
	 * The computation this worker browser implements, named the way a pipeline stage names
	 * its computation.
	 *
	 * A stage is dispatched by its computation and its position in its pipeline, not by its
	 * stage name, so a pipeline may name its shard stages anything as long as it lists three
	 * of them in shard order.
	 */
	static readonly computation = "llm_shard";

	/** How many shards this browser can run, which is how many the loaded model was split into. */
	static readonly shardCount = 3;

	/**
	 * Reports whether this helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return computation === StageLlmHelper.computation;
	}

	/** The three ordered shard sessions: input, middle, and output. */
	private static shardSessions: Array<ShardSession | undefined> = [];
	/** Tokenizer instance, once tokenizer data has loaded. */
	private static tokenizer: Tokenizer | undefined;
	/** Shared promise that prevents concurrent model loads. */
	private static loadPromise: Promise<void> | undefined;
	/** Generation state for each task currently running its shards on this device. */
	private static stateByTaskId = new Map<string, TaskGenerationState>();

	/**
	 * Runs the shard for one assigned stage against the payload received from the gateway.
	 *
	 * @param shardIndex Which shard to run, taken from the assigned stage's position in its pipeline.
	 * @param taskId The task this stage belongs to, used to look up its key-value cache and generated tokens so far.
	 * @param payload The incoming stage payload (the prompt for shard 1's first round, or the previous shard's hand-off otherwise).
	 * @returns The outgoing stage payload to send back as the stage result.
	 * @throws If the pipeline asks for a shard beyond the number this browser's model was split into.
	 */
	static async compute(shardIndex: number, taskId: string, payload: LlmStagePayload): Promise<LlmStagePayload> {
		if (shardIndex < 0 || shardIndex >= StageLlmHelper.shardCount) throw new Error(`This browser runs ${StageLlmHelper.shardCount} language-model shards and was asked for shard ${shardIndex + 1}.`);
		await StageLlmHelper.loadModel([shardIndex]);
		const session = StageLlmHelper.shardSessions[shardIndex];
		if (!session) throw new Error(`LLM shard ${shardIndex + 1} was not loaded.`);
		const isFirstShard = shardIndex === 0;
		const isFirstRound = isFirstShard && payload.inputIds === undefined;
		const state = isFirstRound
			? StageLlmHelper.startTask(taskId)
			: (StageLlmHelper.stateByTaskId.get(taskId) ?? StageLlmHelper.startTask(taskId));

		const inputIds = isFirstRound ? StageLlmHelper.encodePrompt(payload.text ?? "") : (payload.inputIds ?? []);
		const position = payload.position ?? 0;
		const boundary = payload.tensors ? StageLlmHelper.decodeBoundary(payload.tensors) : undefined;

		const outputs = await session.run(StageLlmHelper.buildFeeds(session, inputIds, position, state.caches[shardIndex], boundary));
		state.caches[shardIndex] = Object.fromEntries(
			Object.entries(outputs)
				.filter(([name]) => name.startsWith("present."))
				.map(([name, value]) => [name.replace("present", "past_key_values"), value]),
		);

		const isLastShard = shardIndex === StageLlmHelper.shardCount - 1;
		if (isLastShard) {
			const nextToken = StageLlmHelper.getNextToken(StageLlmHelper.findLogits(session, outputs));
			state.generatedIds.push(nextToken);
			const text = StageLlmHelper.tokenizer?.decode(state.generatedIds, { skip_special_tokens: true }).trim() ?? "";
			const done = nextToken === EOS_TOKEN_ID || state.generatedIds.length >= MAX_NEW_TOKENS;
			if (done) {
				StageLlmHelper.clearTask(taskId);
				return StagePayloadFactory.llmDone(text);
			}
			return StagePayloadFactory.llmContinue(text, nextToken, position + inputIds.length);
		}

		const boundaryNames = SHARD_BOUNDARIES[shardIndex + 1];
		if (!boundaryNames) throw new Error(`Missing boundary definition after shard ${shardIndex + 1}.`);
		return StagePayloadFactory.llmHandoff(
			{
				[boundaryNames.normalized]: StageLlmHelper.encodeTensor(outputs[boundaryNames.normalized]),
				[boundaryNames.residual]: StageLlmHelper.encodeTensor(outputs[boundaryNames.residual]),
			},
			inputIds,
			position,
		);
	}

	/**
	 * Clears a task's in-memory generation state.
	 *
	 * Called once generation finishes naturally, and should also be called when a task's
	 * stage fails, so an abandoned task does not keep its key-value cache in memory forever.
	 *
	 * @param taskId The task whose generation state should be discarded.
	 */
	static clearTask(taskId: string): void {
		StageLlmHelper.stateByTaskId.delete(taskId);
	}

	/**
	 * Preloads the LLM shards enabled for this worker before gateway connection.
	 *
	 * @param shardIndexes Which shards this worker will be asked to run, taken from the
	 * positions of the enabled language-model stages in their pipeline.
	 */
	static preload(shardIndexes: readonly number[]): Promise<void> {
		const runnable = shardIndexes.filter((shardIndex) => shardIndex >= 0 && shardIndex < StageLlmHelper.shardCount);
		return runnable.length === 0 ? Promise.resolve() : StageLlmHelper.loadModel(runnable);
	}

	/** Creates and stores fresh generation state for a task's first round. */
	private static startTask(taskId: string): TaskGenerationState {
		const state: TaskGenerationState = { caches: [undefined, undefined, undefined], generatedIds: [] };
		StageLlmHelper.stateByTaskId.set(taskId, state);
		return state;
	}

	/**
	 * Loads the tokenizer and creates the three ONNX Runtime Web shard sessions once per page.
	 */
	private static async loadModel(requestedShardIndexes: readonly number[]): Promise<void> {
		const shardIndexes = [...new Set(requestedShardIndexes)];
		if (shardIndexes.every((shardIndex) => StageLlmHelper.shardSessions[shardIndex]) && StageLlmHelper.tokenizer) return;
		if (StageLlmHelper.loadPromise) return StageLlmHelper.loadPromise;

		const hasWebGPU = "gpu" in navigator;
		StageLlmHelper.loadPromise = Promise.all([
			fetch(TOKENIZER_URL).then(async (response) => {
				if (!response.ok) throw new Error(`Tokenizer download failed (${response.status}).`);
				return response.json();
			}),
			fetch(TOKENIZER_CONFIG_URL).then(async (response) => {
				if (!response.ok) throw new Error(`Tokenizer configuration download failed (${response.status}).`);
				return response.json();
			}),
			...shardIndexes.map((shardIndex) => StageLlmHelper.fetchModelBytes(SHARD_URLS[shardIndex])),
		]).then(async ([tokenizerJson, tokenizerConfig, ...shardBytes]) => {
			StageLlmHelper.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
			for (const [shardOffset, bytes] of shardBytes.entries()) {
				StageLlmHelper.shardSessions[shardIndexes[shardOffset]] = await OnnxRuntimeWeb.InferenceSession.create(bytes, {
					executionProviders: hasWebGPU ? ["webgpu", "wasm"] : ["wasm"],
					graphOptimizationLevel: "all",
				});
			}
		}).catch((error: unknown) => {
			StageLlmHelper.loadPromise = undefined;
			throw error;
		});
		return StageLlmHelper.loadPromise;
	}

	/** Opens the IndexedDB database used to store the downloaded ONNX model. */
	private static openModelDatabase(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(MODEL_CACHE_NAME, MODEL_CACHE_VERSION);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains("models")) request.result.createObjectStore("models");
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error("Could not open the model cache."));
		});
	}

	/** Reads the shard bytes from IndexedDB, returning no value when unavailable. */
	private static async readCachedModel(cacheKey: string): Promise<ArrayBuffer | undefined> {
		try {
			const database = await StageLlmHelper.openModelDatabase();
			return await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
				const request = database.transaction("models", "readonly").objectStore("models").get(cacheKey);
				request.onsuccess = () => resolve(request.result as ArrayBuffer | undefined);
				request.onerror = () => reject(request.error ?? new Error("Could not read the model cache."));
			}).finally(() => database.close());
		} catch {
			return undefined;
		}
	}

	/** Stores the downloaded shard bytes in IndexedDB for later page loads. */
	private static async cacheModel(model: ArrayBuffer, cacheKey: string): Promise<void> {
		try {
			const database = await StageLlmHelper.openModelDatabase();
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction("models", "readwrite");
				transaction.objectStore("models").put(model, cacheKey);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error ?? new Error("Could not write the model cache."));
			}).finally(() => database.close());
		} catch {
			// Caching is a speed optimization only; a failed write should not block inference.
		}
	}

	/** Returns shard bytes from IndexedDB or downloads and caches a fresh copy. */
	private static async fetchModelBytes(url: string): Promise<ArrayBuffer> {
		const cached = await StageLlmHelper.readCachedModel(url);
		if (cached) return cached;
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Shard download failed (${response.status}).`);
		const bytes = await response.arrayBuffer();
		await StageLlmHelper.cacheModel(bytes, url);
		return bytes;
	}

	/** Encodes a prompt with the Qwen3 chat template and returns its token identifiers. */
	private static encodePrompt(prompt: string): number[] {
		if (!StageLlmHelper.tokenizer) throw new Error("The tokenizer is not loaded.");
		const formattedPrompt = `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
		return StageLlmHelper.tokenizer.encode(formattedPrompt).ids;
	}

	/** Builds the inputs for one shard call, reusing that shard's own key-value cache from its previous round when available. */
	private static buildFeeds(session: ShardSession, inputIds: number[], position: number, cache: TensorMap | undefined, boundary: TensorMap | undefined): TensorMap {
		const feeds: TensorMap = {
			input_ids: new OnnxRuntimeWeb.Tensor("int64", BigInt64Array.from(inputIds, BigInt), [1, inputIds.length]),
			attention_mask: new OnnxRuntimeWeb.Tensor(
				"int64",
				BigInt64Array.from({ length: position + inputIds.length }, () => 1n),
				[1, position + inputIds.length],
			),
			position_ids: new OnnxRuntimeWeb.Tensor(
				"int64",
				BigInt64Array.from(inputIds, (_, index) => BigInt(position + index)),
				[1, inputIds.length],
			),
		};
		if (boundary) Object.assign(feeds, boundary);
		for (const name of session.inputNames.filter((inputName) => inputName.startsWith("past_key_values."))) {
			feeds[name] = cache?.[name] ?? new OnnxRuntimeWeb.Tensor("float16", new Uint16Array(0), [1, 8, 0, 128]);
		}
		return feeds;
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

	/** Finds the logits tensor among a shard's outputs. */
	private static findLogits(session: ShardSession, outputs: TensorMap): OnnxRuntimeWeb.Tensor {
		const logitsName = session.outputNames.find((name) => name === "logits" || name.endsWith(".logits"));
		const logits = logitsName ? outputs[logitsName] : undefined;
		if (!logits) throw new Error(`The model did not return logits. Outputs: ${Object.keys(outputs).join(", ")}`);
		return logits;
	}

	/** Encodes a tensor's dimensions, type, and raw bytes as base64 text for a JSON message. */
	private static encodeTensor(tensor: OnnxRuntimeWeb.Tensor): EncodedTensor {
		const view = tensor.data as ArrayBufferView;
		const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
		let binary = "";
		const chunkSize = 0x8000;
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
		}
		return { dims: [...tensor.dims], type: tensor.type, dataBase64: btoa(binary) };
	}

	/** Decodes the boundary tensors received from the previous shard's stage result. */
	private static decodeBoundary(tensors: Record<string, EncodedTensor>): TensorMap {
		return Object.fromEntries(
			Object.entries(tensors).map(([name, encoded]) => [name, StageLlmHelper.decodeTensor(encoded)]),
		);
	}

	/** Decodes one base64-encoded tensor back into an ONNX Runtime tensor. */
	private static decodeTensor(encoded: EncodedTensor): OnnxRuntimeWeb.Tensor {
		const binary = atob(encoded.dataBase64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		const TypedArrayConstructor = TYPED_ARRAY_BY_ONNX_TYPE[encoded.type];
		if (!TypedArrayConstructor) throw new Error(`Unsupported tensor type for decoding: ${encoded.type}`);
		const data = new TypedArrayConstructor(bytes.buffer);
		return new OnnxRuntimeWeb.Tensor(encoded.type as OnnxRuntimeWeb.Tensor.Type, data, encoded.dims);
	}
}
