#!/usr/bin/env -S npx tsx

// node imports
import Fs from 'node:fs';
import Url from 'node:url';

// npm imports
import { Command } from 'commander';

// local imports
import { taskTypeNames, taskTypeNamesAcceptingConversation } from '@webai/consumer-cli';
import { BenchmarkCommand, type RawBenchmarkOptions } from './commands/benchmark_command.js';
import { ConversationHistoryCommand, type RawConversationHistoryOptions } from './commands/conversation_history_command.js';
import { TextCompletionCommand, type RawTextCompletionOptions } from './commands/text_completion_command.js';
import { benchmarkReportFormats } from './completion_types.js';
import { SharedOptions } from './shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the openai_api_tool command line program and its three subcommands
//
//	Run with:
//	  ./src/cli.ts text_completion --streamed --model llm_qwen3_0_6b_sharded
//	  ./src/cli.ts conversation_history --model llm_llama3_2_3b_full
//	  ./src/cli.ts benchmark --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct
//	or, from the workspace:
//	  npm run text_completion --workspace @webai/openai-api-tool -- --model all
//
//	`-m/--model` accepts one model identifier, a comma-separated list of identifiers, a pattern
//	such as `llm_*`, `all`, or `list` to print the model identifiers and send nothing. Neither
//	`-s/--streamed` nor `--nostream` given sweeps both modes, which is what makes a bare
//	subcommand the whole sweep across every model and every mode it applies to.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `openai_api_tool` command line program. */
export class Cli {
	/**
	 * Parses the command line and dispatches to `text_completion`, `conversation_history`, or
	 * `benchmark`.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the arguments
	 * this process was started with.
	 * @returns Nothing, once the subcommand has finished. Sets `process.exitCode` to `1` when the
	 * command line itself was unusable, such as an `-m/--model` pattern matching nothing, reported
	 * in words rather than as a stack trace.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Command();
		program.name('openai_api_tool').description('Exercises and measures a server that speaks the OpenAI-compatible API.');

		const textCompletion = program
			.command('text_completion')
			.description('Sends one chat completion request per model and per mode, and reports which ones answered.')
			.option(
				'-m, --model <name>',
				'model identifier, a comma-separated list of identifiers, a pattern such as llm_*, all, or list to print the model identifiers',
				'all',
			)
			.option('-p, --prompt <text>', "the prompt to send instead of each model's own default prompt");
		SharedOptions.addModeOptions(textCompletion);
		SharedOptions.addEndpointOptions(textCompletion);
		textCompletion.action(async (rawOptions: RawTextCompletionOptions) => {
			await TextCompletionCommand.run(rawOptions);
		});

		const conversationHistory = program
			.command('conversation_history')
			.description(
				"Sends a two-turn conversation to a model that accepts one, and checks that the second turn's answer recalls what the first turn said.",
			)
			.option(
				'-m, --model <name>',
				`model identifier, a comma-separated list of identifiers, a pattern, all, or list to print the model identifiers — only ${taskTypeNamesAcceptingConversation.join(' and ')} accept a whole conversation`,
				'all',
			);
		SharedOptions.addModeOptions(conversationHistory);
		SharedOptions.addEndpointOptions(conversationHistory);
		conversationHistory.action(async (rawOptions: RawConversationHistoryOptions) => {
			await ConversationHistoryCommand.run(rawOptions);
		});

		const benchmark = program
			.command('benchmark')
			.description("Measures one OpenAI-compatible endpoint's streamed chat completion latency, one model at a time.")
			.option(
				'-m, --model <name>',
				`model identifier, a comma-separated list of identifiers, a pattern, all, or list — a name outside ${taskTypeNames.join(', ')} is sent to the endpoint unchanged, so another server's own model names work`,
				'all',
			)
			.option('-p, --prompt <text>', 'the one prompt sent to the endpoint', BenchmarkCommand.defaultPrompt)
			.option('-r, --runs <number>', 'measured requests per model', '10')
			.option('-w, --warmup_runs <number>', 'unreported warm-up requests per model', '1')
			.option('-f, --format <format>', `output format: ${benchmarkReportFormats.join(', ')}`, 'text');
		SharedOptions.addEndpointOptions(benchmark);
		benchmark.action(async (rawOptions: RawBenchmarkOptions) => {
			await BenchmarkCommand.run(rawOptions);
		});

		try {
			await program.parseAsync(args, { from: 'user' });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = 1;
		}
	}

	/**
	 * Reports whether this module was started directly, rather than imported.
	 *
	 * `tsx` invokes this file through `process.argv[1]`, while `import.meta.url` is Node's
	 * already-resolved real path. Comparing both sides after resolving symlinks means a test that
	 * imports this module for its exports never triggers command line parsing.
	 *
	 * @returns `true` when this process was started to run this file.
	 */
	static isMainModule(): boolean {
		if (process.argv[1] === undefined) {
			return false;
		}
		try {
			return Url.fileURLToPath(import.meta.url) === Fs.realpathSync(process.argv[1]);
		} catch {
			return false;
		}
	}
}

if (Cli.isMainModule()) {
	await Cli.run();
}
