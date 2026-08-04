import * as Commander from 'commander';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LmstudioExampleOptions — reads the base URL and the model list an example runs against
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The base URL of LM Studio's OpenAI-compatible API, as LM Studio serves it out of the box. */
const defaultBaseUrl = 'http://localhost:1234/v1';

/** The word `--model` accepts in place of an identifier, to mean every chat model LM Studio has downloaded. */
const everyModelKeyword = 'all';

/**
 * The word `--model` accepts in place of an identifier, to mean every chat model LM Studio
 * currently holds in memory.
 */
const loadedModelsKeyword = 'loaded';

/**
 * The models the examples compare when nothing else was asked for, which are the models whose
 * results the package README records. Each one is loaded by LM Studio on demand. One that has not
 * been downloaded is not refused: LM Studio answers it with whichever model it currently holds in
 * memory, and the results row says so rather than crediting the answer to the model that was asked
 * for.
 */
const comparedModelIds = [
	'llama-3.2-3b-instruct',
	'qwen3.5-2b-mlx',
];

/** How long a request to a model list may take before it is given up on, in milliseconds. */
const modelListTimeoutMs = 10_000;

/**
 * The kinds of model LM Studio reports that answer a chat completion request: `llm` for a
 * text-only chat model, `vlm` for a chat model that can also be given images. Both are asked the
 * same text-only questions here. Every other kind LM Studio reports, `embeddings` above all, is
 * left out, because sending one a chat request only produces an error.
 */
const chatModelKinds = ['llm', 'vlm'];

/** What one example was told to run against, once the command line and the environment have been read. */
export type ExampleOptionValues = {
	/** The base URL of LM Studio's OpenAI-compatible API, without a trailing slash. */
	baseUrl: string;
	/** The identifiers of the models to run against, in the order they will be run. */
	modelIds: string[];
};

/**
 * One entry of the model list LM Studio's own REST API returns from `GET /api/v0/models`.
 *
 * That list is read rather than the OpenAI-compatible `GET /v1/models` one because it says which
 * kind each model is and whether it is loaded, and an embedding model must not be sent a chat
 * request.
 */
type LmstudioModelListEntry = {
	/** The identifier a chat completion request names in its `model` field. */
	id: string;
	/**
	 * Which kind of model this is, such as `llm` for a text-only chat model, `vlm` for a chat model
	 * that can also be given images, or `embeddings` for an embedding model.
	 */
	type: string;
	/** Whether LM Studio currently holds this model in memory: `loaded` or `not-loaded`. */
	state: string;
};

/** The answer to `GET /api/v0/models`. */
type LmstudioModelListResponse = {
	/** Every model LM Studio has downloaded, loaded or not. */
	data: LmstudioModelListEntry[];
};

/**
 * Reads which LM Studio server, and which models on it, one example runs against.
 *
 * Every one of these examples is meant to be run again and again against a different model, so
 * switching models is one option and nothing else: load another model in LM Studio and run the
 * example again, or name the models on the command line. Nothing in an example names a model
 * itself.
 */
export class LmstudioExampleOptions {
	/**
	 * Reads the command line and the environment, and works out which models to run against.
	 *
	 * `--model` accepts one or more identifiers, the single word `all` for every chat model LM
	 * Studio has downloaded, or the single word `loaded` for the ones it currently holds in memory,
	 * so that loading a different model in the LM Studio application is by itself enough to run the
	 * example against it. With no `--model` at all, the models named in {@link comparedModelIds}
	 * are used.
	 *
	 * @param description The one-line description of the example, shown by `--help`.
	 * @returns The base URL to talk to and the models to run against.
	 * @throws If LM Studio cannot be reached, or holds no chat model to run against.
	 */
	static async read(description: string): Promise<ExampleOptionValues> {
		const program = new Commander.Command();
		program
			.description(description)
			.option(
				'-b, --base-url <url>',
				"The base URL of LM Studio's OpenAI-compatible API.",
				process.env.LMSTUDIO_BASE_URL ?? defaultBaseUrl,
			)
			.option(
				'-m, --model <id...>',
				`The models to run against, named as LM Studio names them. Give "${everyModelKeyword}" `
					+ `for every chat model LM Studio has downloaded, or "${loadedModelsKeyword}" for `
					+ `the ones it currently holds in memory. Left out: ${comparedModelIds.join(', ')}.`,
				LmstudioExampleOptions._modelIdsFromEnvironment(),
			)
			.parse(process.argv);
		const commandLine = program.opts<{ baseUrl: string; model?: string[]; }>();
		const baseUrl = commandLine.baseUrl.replace(/\/+$/, '');
		const askedForModelIds = commandLine.model ?? [];

		if (askedForModelIds.length === 1 && askedForModelIds[0] === everyModelKeyword) {
			const modelIds = await LmstudioExampleOptions._chatModelIds(baseUrl, false);
			if (modelIds.length === 0) {
				throw new Error(`LM Studio at ${baseUrl} has no chat model downloaded`);
			}
			return {
				baseUrl,
				modelIds,
			};
		}

		if (askedForModelIds.length === 1 && askedForModelIds[0] === loadedModelsKeyword) {
			const modelIds = await LmstudioExampleOptions._chatModelIds(baseUrl, true);
			if (modelIds.length === 0) {
				throw new Error(
					`LM Studio at ${baseUrl} holds no chat model in memory. Load one in the LM Studio `
						+ 'application, or name the models with --model.',
				);
			}
			return {
				baseUrl,
				modelIds,
			};
		}

		if (askedForModelIds.length > 0) {
			return {
				baseUrl,
				modelIds: askedForModelIds,
			};
		}

		return {
			baseUrl,
			modelIds: comparedModelIds,
		};
	}

	/**
	 * Prints which server and which models the example is about to run against.
	 *
	 * @param options The base URL and models the example was told to run against.
	 * @returns Nothing.
	 */
	static announce(options: ExampleOptionValues): void {
		console.log(`LM Studio at ${options.baseUrl}`);
		console.log(`models: ${options.modelIds.join(', ')}`);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the models named by the `LMSTUDIO_MODEL` environment variable, which holds one
	 * identifier or several separated by commas.
	 *
	 * @returns The identifiers it named, or an empty list when it is unset or empty.
	 */
	private static _modelIdsFromEnvironment(): string[] {
		const value = process.env.LMSTUDIO_MODEL;
		if (value === undefined) {
			return [];
		}
		return value.split(',').map((modelId) => modelId.trim()).filter((modelId) => modelId !== '');
	}

	/**
	 * Asks LM Studio which chat models it has, through its own REST API rather than the
	 * OpenAI-compatible one, so that embedding models can be left out.
	 *
	 * @param baseUrl The base URL of LM Studio's OpenAI-compatible API, such as
	 * `http://localhost:1234/v1`. The REST API sits next to it on the same host and port.
	 * @param onlyLoaded Whether to return only the models LM Studio currently holds in memory,
	 * rather than every model it has downloaded.
	 * @returns The chat model identifiers, in the order LM Studio listed them.
	 * @throws If LM Studio cannot be reached, or answers with a failure status.
	 */
	private static async _chatModelIds(baseUrl: string, onlyLoaded: boolean): Promise<string[]> {
		const restApiUrl = `${baseUrl.replace(/\/v1$/, '')}/api/v0/models`;
		const response = await fetch(restApiUrl, {
			signal: AbortSignal.timeout(modelListTimeoutMs),
		}).catch((error: unknown) => {
			throw new Error(
				`LM Studio at ${restApiUrl} could not be reached: `
					+ `${error instanceof Error ? error.message : String(error)}. `
					+ 'Start it with "lms server start".',
			);
		});
		if (response.ok === false) {
			throw new Error(`LM Studio at ${restApiUrl} answered its model list with status ${response.status}`);
		}
		const body = await response.json() as LmstudioModelListResponse;
		if (Array.isArray(body.data) === false) {
			throw new Error(`LM Studio at ${restApiUrl} answered its model list without a "data" array`);
		}
		return body.data
			.filter((entry) => chatModelKinds.includes(entry.type))
			.filter((entry) => onlyLoaded === false || entry.state === 'loaded')
			.map((entry) => entry.id);
	}
}
