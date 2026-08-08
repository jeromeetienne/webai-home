// npm imports
import type OpenAI from 'openai';

// local imports
import { taskTypeNamesAcceptingConversation } from '@webai/consumer-cli';
import { CompletionSender } from '../completion_sender.js';
import type { CompletionMode, SweepOutcome } from '../completion_types.js';
import { ModelSweeper } from '../model_sweeper.js';
import { ReportRenderer } from '../report_renderer.js';
import { SharedOptions, type RawSharedOptions } from '../shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HistoryCommand — checks that a second turn recalls what the first turn said
//
//	Sends a two-turn conversation and checks that the second turn's answer recalls both facts the
//	first turn stated, across every model in `taskTypeNamesAcceptingConversation` — the only
//	models whose task type accepts a whole conversation rather than only one prompt.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `history` subcommand's own options, exactly as commander parses them. */
export type RawHistoryOptions = RawSharedOptions;

/** Sends a two-turn conversation to a model that accepts one, and checks what the second turn recalls. */
export class HistoryCommand {
	/** The first turn, stating a fact and nothing else. */
	private static readonly _firstMessage = 'My name is Ada and my favorite programming language is Lisp. Please just say hello back.';

	/** The second turn, asking a question that can only be answered by recalling what the first turn said. */
	private static readonly _secondMessage = 'What is my name, and what is my favorite programming language? Answer in one short sentence.';

	/**
	 * Runs the `history` subcommand: sweeps every requested model and mode pair, one at a time,
	 * prints the two turns and one analysis line per pair, and finishes with a summary table.
	 *
	 * `-m/--model list` prints `taskTypeNamesAcceptingConversation` rather than every model on
	 * offer, since only those models accept a whole conversation.
	 *
	 * @param rawOptions The subcommand's own options, exactly as commander parsed them.
	 * @returns Nothing. Sets `process.exitCode` to `1` when any pair failed.
	 */
	static async run(rawOptions: RawHistoryOptions): Promise<void> {
		if (rawOptions.model === 'list') {
			SharedOptions.printModelIds(taskTypeNamesAcceptingConversation);
			return;
		}

		const modelIds = ModelSweeper.resolveModelIds(rawOptions.model, taskTypeNamesAcceptingConversation, 'reject');
		const modes = SharedOptions.resolveModes(rawOptions);
		const client = CompletionSender.createClient(SharedOptions.buildTarget(rawOptions));

		const outcomes: SweepOutcome[] = [];
		for (const modelId of modelIds) {
			for (const mode of modes) {
				const outcome = await HistoryCommand._sweepOne(client, modelId, mode);
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
	 * Sweeps one model and one mode: sends the first turn, then sends the second turn with the
	 * first turn's own answer carried along with it, and checks that the second answer recalls
	 * both facts the first turn stated.
	 *
	 * @param client The OpenAI client pointed at the endpoint under test.
	 * @param modelId The model identifier to request.
	 * @param mode Whether to ask for each turn's answer as it is written, or in one piece.
	 * @returns What happened. The timings and character count are the second turn's own, since
	 * that is the request whose latency and recall this subcommand measures.
	 */
	private static async _sweepOne(client: OpenAI, modelId: string, mode: CompletionMode): Promise<SweepOutcome> {
		const startedAt = performance.now();
		try {
			process.stdout.write('turn 1: ');
			const firstTurn = await CompletionSender.send({
				client,
				modelId,
				messages: [
					{
						role: 'user',
						content: HistoryCommand._firstMessage,
					},
				],
				mode,
				writePiece: (piece) => process.stdout.write(piece),
			});
			process.stdout.write('\n');

			process.stdout.write('turn 2: ');
			const secondTurn = await CompletionSender.send({
				client,
				modelId,
				messages: [
					{
						role: 'user',
						content: HistoryCommand._firstMessage,
					},
					{
						role: 'assistant',
						content: firstTurn.answer,
					},
					{
						role: 'user',
						content: HistoryCommand._secondMessage,
					},
				],
				mode,
				writePiece: (piece) => process.stdout.write(piece),
			});
			process.stdout.write('\n');

			const secondAnswerLower = secondTurn.answer.toLowerCase();
			const recalledName = secondAnswerLower.includes('ada');
			const recalledLanguage = secondAnswerLower.includes('lisp');
			if (recalledName === false || recalledLanguage === false) {
				throw new Error(`the second turn's answer did not recall both facts the first turn stated: "${secondTurn.answer}"`);
			}

			return {
				modelId,
				mode,
				status: 'ok',
				timeToFirstCharacterMs: secondTurn.timeToFirstCharacterMs,
				timeToLastCharacterMs: secondTurn.timeToLastCharacterMs,
				characterCount: secondTurn.answer.length,
				answer: secondTurn.answer,
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
