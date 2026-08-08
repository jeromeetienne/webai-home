// npm imports
import type OpenAI from 'openai';

// local imports
import { taskTypeNames } from '@webai/consumer-cli';
import { CompletionSender } from '../completion_sender.js';
import type { CompletionMode, SweepOutcome } from '../completion_types.js';
import { ModelSweeper } from '../model_sweeper.js';
import { ReportRenderer } from '../report_renderer.js';
import { SharedOptions, type RawSharedOptions } from '../shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CompletionCommand — sends one prompt per model and per mode, and reports which answered
//
//	Every model of `taskTypeNames` has its own default prompt: `5` for `dev_formula`, which
//	accepts only a number, and a plain question for every other model. Each pair is sent one at a
//	time; a failure is reported and the run carries on with the next pair.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `completion` subcommand's own options, exactly as commander parses them. */
export type RawCompletionOptions = RawSharedOptions & {
	/** The prompt to send instead of each model's own default prompt. */
	prompt?: string;
};

/** Sends one chat completion request per model and per mode, and reports which ones answered. */
export class CompletionCommand {
	/** The prompt sent to `dev_formula`, which accepts only a number and answers with a number. */
	private static readonly _devFormulaPrompt = '5';

	/** The prompt sent to every model other than `dev_formula`. */
	private static readonly _defaultLanguagePrompt = 'What is the capital of France?';

	/**
	 * Runs the `completion` subcommand: sweeps every requested model and mode pair, one at a
	 * time, prints one line per pair, and finishes with a summary table.
	 *
	 * `-m/--model list` is handled first, as a request to print the model identifiers rather than
	 * to send anything, so it needs neither `-u/--base_url` to answer nor a gateway to be reachable.
	 *
	 * @param rawOptions The subcommand's own options, exactly as commander parsed them.
	 * @returns Nothing. Sets `process.exitCode` to `1` when any pair failed.
	 */
	static async run(rawOptions: RawCompletionOptions): Promise<void> {
		if (rawOptions.model === 'list') {
			SharedOptions.printModelIds(taskTypeNames);
			return;
		}

		const modelIds = ModelSweeper.resolveModelIds(rawOptions.model, taskTypeNames, 'accept');
		const modes = SharedOptions.resolveModes(rawOptions);
		const client = CompletionSender.createClient(SharedOptions.buildTarget(rawOptions));

		const outcomes: SweepOutcome[] = [];
		for (const modelId of modelIds) {
			const prompt = rawOptions.prompt ?? CompletionCommand._defaultPromptFor(modelId);
			for (const mode of modes) {
				const outcome = await CompletionCommand._sweepOne(client, modelId, mode, prompt);
				outcomes.push(outcome);
				ReportRenderer.printSweepOutcome(outcome);
			}
		}

		ReportRenderer.printSweepSummary(outcomes);
		if (outcomes.some((outcome) => outcome.status === 'failed')) {
			process.exitCode = 1;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * The default prompt for one model.
	 *
	 * @param modelId The model identifier.
	 * @returns `5` for `dev_formula`, and a plain question for every other model.
	 */
	private static _defaultPromptFor(modelId: string): string {
		if (modelId === 'dev_formula') {
			return CompletionCommand._devFormulaPrompt;
		}
		return CompletionCommand._defaultLanguagePrompt;
	}

	/**
	 * Sweeps one model and one mode: sends the one prompt, and turns either the answer or the
	 * failure into a `SweepOutcome`.
	 *
	 * `dev_formula` asked to stream is skipped rather than sent, because `TaskInputFactory` in
	 * `@webai/consumer-cli` refuses it outright — the `dev_formula` task answers with one number,
	 * so it cannot produce its answer in pieces. That is a permanent, documented restriction
	 * rather than something this run could ever fix, so it is reported apart from an actual failure.
	 *
	 * @param client The OpenAI client pointed at the endpoint under test.
	 * @param modelId The model identifier to request.
	 * @param mode Whether to ask for the answer as it is written, or in one piece.
	 * @param prompt The single user message to send.
	 * @returns What happened.
	 */
	private static async _sweepOne(client: OpenAI, modelId: string, mode: CompletionMode, prompt: string): Promise<SweepOutcome> {
		if (modelId === 'dev_formula' && mode === 'streamed') {
			return {
				modelId,
				mode,
				status: 'skipped',
				timeToFirstCharacterMs: 0,
				timeToLastCharacterMs: 0,
				characterCount: 0,
				answer: '',
				failureMessage: 'the dev_formula task answers with one number, so it cannot produce its answer in pieces',
			};
		}

		const startedAt = performance.now();
		try {
			process.stdout.write(`${mode}: `);
			const result = await CompletionSender.send({
				client,
				modelId,
				messages: [
					{
						role: 'user',
						content: prompt,
					},
				],
				mode,
				writePiece: (piece) => process.stdout.write(piece),
			});
			process.stdout.write('\n');
			return {
				modelId,
				mode,
				status: 'ok',
				timeToFirstCharacterMs: result.timeToFirstCharacterMs,
				timeToLastCharacterMs: result.timeToLastCharacterMs,
				characterCount: result.answer.length,
				answer: result.answer,
				failureMessage: undefined,
			};
		} catch (error: unknown) {
			process.stdout.write('\n');
			const elapsedMs = performance.now() - startedAt;
			return {
				modelId,
				mode,
				status: 'failed',
				timeToFirstCharacterMs: elapsedMs,
				timeToLastCharacterMs: elapsedMs,
				characterCount: 0,
				answer: '',
				failureMessage: CompletionSender.describeFailure(error),
			};
		}
	}
}
