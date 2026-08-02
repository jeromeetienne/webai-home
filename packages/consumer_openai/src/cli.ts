// node imports
import Fs from 'node:fs';
import Url from 'node:url';

// local imports
import { ServerCli } from './server_cli.js';
import { Benchmark } from './benchmark.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the consumer_openai command line program: server and benchmark
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The subcommand names this program dispatches to. */
const subcommandNames = ['server', 'benchmark'] as const;

/**
 * The command line program of `@webai/consumer-openai`: `server` serves the OpenAI-compatible
 * completion interface in front of the cluster, and `benchmark` compares its latency with LM
 * Studio directly. Each subcommand parses its own remaining arguments and reads its own
 * `--help`, exactly as it did as a standalone script, so this dispatcher only picks which one
 * to hand the rest of the command line to.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 * @returns Nothing, once the chosen subcommand has finished.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const [subcommand, ...rest] = args;
		if (subcommand === 'server') {
			ServerCli.run(rest);
			return;
		}
		if (subcommand === 'benchmark') {
			await Benchmark.runCli(rest);
			return;
		}
		if (subcommand === undefined || subcommand === '-h' || subcommand === '--help') {
			Cli._printUsage();
			process.exitCode = subcommand === undefined ? 1 : 0;
			return;
		}
		console.error(`Unknown command: ${subcommand}\n`);
		Cli._printUsage();
		process.exitCode = 1;
	}

	/**
	 * Reports whether this module was started directly, rather than imported.
	 *
	 * `npx`, and the `bin` symlink `npm install` creates for it, invoke this file through a
	 * symlink under `node_modules/.bin`, so `process.argv[1]` is the symlink path while
	 * `import.meta.url` is Node's already-resolved real path. Comparing both sides after
	 * resolving symlinks handles that invocation the same as running this file directly.
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

	/** Prints the two subcommands this program accepts, and where to find each one's own options. */
	private static _printUsage(): void {
		console.log('Usage: consumer_openai <command> [options]');
		console.log();
		console.log('Commands:');
		console.log(`  ${subcommandNames[0]}      serve the OpenAI-compatible completion interface in front of the webai-at-home cluster`);
		console.log(`  ${subcommandNames[1]}   compare direct LM Studio latency with the same model behind webai-at-home`);
		console.log();
		console.log('Run "consumer_openai <command> --help" for a command\'s own options.');
	}
}

if (Cli.isMainModule()) {
	await Cli.run();
}
