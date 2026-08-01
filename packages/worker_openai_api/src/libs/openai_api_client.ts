///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiApiClient — talks to one local server that speaks the OpenAI-compatible API
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How long a request to the local server may take before it is given up on, in milliseconds. */
const requestTimeoutMs = 10_000;

/**
 * One entry of the model list a server returns from `GET /v1/models`.
 *
 * Only the identifier is read here. Ollama and LM Studio each return more fields than this,
 * and neither set is part of what this worker relies on.
 */
type ModelListEntry = {
	/** The identifier a completion request names in its `model` field, such as `llama3.2:3b`. */
	id: string;
};

/** The answer to `GET /v1/models`, as both Ollama and LM Studio return it. */
type ModelListResponse = {
	/** The models the server currently offers. */
	data: ModelListEntry[];
};

/**
 * Talks to one locally running server that speaks the OpenAI-compatible API, such as Ollama or
 * LM Studio.
 *
 * The server is named by a base URL rather than chosen here, because which server a worker
 * talks to is decided by whoever starts the worker process. The client holds that base URL, so
 * it has state and its methods are instance methods.
 *
 * This client covers the model list today. The Chat Completions endpoint that carries out a
 * stage is added in step 3 of https://github.com/webai-at-home/webai-at-home/issues/103.
 */
export class OpenaiApiClient {
	/**
	 * @param baseUrl The base URL of the local server's OpenAI-compatible API, without a
	 * trailing slash, such as `http://localhost:11434/v1`.
	 */
	constructor(private readonly baseUrl: string) {
	}

	/**
	 * Lists the models the local server currently offers.
	 *
	 * @returns The model identifiers, in the order the server listed them.
	 * @throws If the server cannot be reached, answers with a failure status, or answers with
	 * something that is not a model list.
	 */
	async listModelIds(): Promise<string[]> {
		const response = await fetch(`${this.baseUrl}/models`, {
			signal: AbortSignal.timeout(requestTimeoutMs),
		}).catch((error: unknown) => {
			throw new Error(`The server at ${this.baseUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (response.ok === false) {
			throw new Error(`The server at ${this.baseUrl} answered its model list with status ${response.status}`);
		}
		const body = await response.json() as ModelListResponse;
		if (Array.isArray(body.data) === false) {
			throw new Error(`The server at ${this.baseUrl} answered its model list without a "data" array`);
		}
		return body.data.map((entry) => entry.id);
	}
}
