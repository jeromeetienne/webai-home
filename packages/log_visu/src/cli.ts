import NodeFs from "node:fs";
import NodePath from "node:path";
import NodeUrl from "node:url";
import NodeHttp from "node:http";
import NodeChildProcess from "node:child_process";
import * as Commander from "commander";
import { LogEntryParser } from "../public/src/log_entry_parser.js";
import type { InitialUiState, LogSource, SessionPayload } from "../public/src/types.js";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

interface CliOptions {
	logsDir: string | undefined;
	from: string | undefined;
	to: string | undefined;
	chatter: boolean;
	signaling: boolean;
	speed: string;
	autoplay: boolean;
	port: string;
	open: boolean;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MainHelper — the `log-visu` CLI: merges log files and serves a ready-to-watch page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Loads one or more server message log files, merges them into a single session
 * (each file keeping its own server node so multiple runs stay visually separated),
 * and serves the visualizer page with that session already loaded — and, by default,
 * already playing — so watching a capture takes one command line and no clicking.
 */
export class MainHelper {
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const command = new Commander.Command()
			.argument("[files...]", "log files to merge (defaults to every packages/server/logs/server-*.jsonl file)")
			.option("--logs-dir <dir>", "directory to scan for server-*.jsonl files when no files are given")
			.option("--from <datetime>", "start of the time range to show (defaults to the earliest message loaded)")
			.option("--to <datetime>", "end of the time range to show (defaults to the latest message loaded)")
			.option("--chatter", "show connection chatter (register / registered / devices) on load", false)
			.option("--signaling", "show peer connection signaling on load", false)
			.option("--speed <multiplier>", "initial playback speed", "1")
			.option("--no-autoplay", "load paused instead of playing immediately")
			.option("--port <number>", "port to serve on (0 picks a free port)", "0")
			.option("--no-open", "do not open a browser window automatically");
		command.parse([process.argv[0]!, process.argv[1] ?? "", ...args]);

		const options = command.opts<CliOptions>();
		const filePaths: string[] = MainHelper._resolveFilePaths(command.args, options.logsDir);
		if (filePaths.length === 0) {
			console.error("No log files found. Pass one or more .jsonl files, or run the server first so packages/server/logs has some.");
			process.exitCode = 1;
			return;
		}

		const sources: LogSource[] = MainHelper._loadSources(filePaths);
		const fullRangeMs = MainHelper._computeFullRangeMs(sources);
		if (fullRangeMs === undefined) {
			console.error("None of the given files contained a valid log entry.");
			process.exitCode = 1;
			return;
		}

		const initialState: InitialUiState = {
			fromMs: options.from !== undefined ? MainHelper._parseDatetime(options.from, "--from") : fullRangeMs.fromMs,
			toMs: options.to !== undefined ? MainHelper._parseDatetime(options.to, "--to") : fullRangeMs.toMs,
			showChatter: options.chatter,
			showSignaling: options.signaling,
			speed: Number(options.speed),
			autoplay: options.autoplay,
		};
		const session: SessionPayload = { sources, initialState };

		const totalMessages: number = sources.reduce((sum: number, source: LogSource): number => sum + source.entries.length, 0);
		console.log(`Loaded ${sources.length} log source(s), ${totalMessages} message(s) total:`);
		for (const source of sources) console.log(`  - ${source.label}: ${source.entries.length} message(s)`);

		const url: string = await MainHelper._serve(session, Number(options.port));
		console.log(`\nServing the visualizer at ${url}`);
		if (options.open) MainHelper._openBrowser(url);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	private static _resolveFilePaths(explicitFiles: string[], logsDirOption: string | undefined): string[] {
		if (explicitFiles.length > 0) return explicitFiles.map((filePath: string): string => NodePath.resolve(process.cwd(), filePath));

		const logsDir: string =
			logsDirOption !== undefined
				? NodePath.resolve(process.cwd(), logsDirOption)
				: NodeUrl.fileURLToPath(new URL("../../server/logs", import.meta.url));

		if (!NodeFs.existsSync(logsDir)) return [];
		return NodeFs.readdirSync(logsDir)
			.filter((fileName: string): boolean => /^server-.*\.jsonl$/.test(fileName))
			.sort()
			.map((fileName: string): string => NodePath.join(logsDir, fileName));
	}

	private static _loadSources(filePaths: string[]): LogSource[] {
		const sources: LogSource[] = [];
		for (const filePath of filePaths) {
			const text: string = NodeFs.readFileSync(filePath, "utf-8");
			const { entries, lineErrors } = LogEntryParser.parseJsonl(text);
			if (entries.length === 0) continue;
			for (const lineError of lineErrors) console.warn(`${NodePath.basename(filePath)}: ${lineError}`);

			sources.push({
				id: NodePath.basename(filePath).replace(/\.jsonl$/, ""),
				label: MainHelper._labelForFile(filePath),
				entries,
			});
		}
		return sources;
	}

	private static _labelForFile(filePath: string): string {
		const fileName: string = NodePath.basename(filePath);
		const runMatch = /^server-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/.exec(fileName);
		if (runMatch === null) return fileName;
		const [, year, month, day, hour, minute, second] = runMatch;
		return `Server (${month}/${day} ${hour}:${minute}:${second})`;
	}

	private static _computeFullRangeMs(sources: LogSource[]): { fromMs: number; toMs: number } | undefined {
		const timestamps: number[] = sources.flatMap((source: LogSource): number[] => source.entries.map((entry): number => Date.parse(entry.timestamp)));
		if (timestamps.length === 0) return undefined;
		return { fromMs: Math.min(...timestamps), toMs: Math.max(...timestamps) };
	}

	private static _parseDatetime(value: string, flagName: string): number {
		const parsedMs: number = Date.parse(value);
		if (Number.isNaN(parsedMs)) throw new Error(`${flagName} is not a valid date/time: ${value}`);
		return parsedMs;
	}

	private static async _serve(session: SessionPayload, requestedPort: number): Promise<string> {
		const publicDirectory: string = NodeUrl.fileURLToPath(new URL("../public", import.meta.url));
		const viteDevServer = await (await import("vite")).createServer({
			root: publicDirectory,
			server: { middlewareMode: true, hmr: false },
			appType: "spa",
		});

		const httpServer = NodeHttp.createServer((request, response) => {
			const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
			if (pathname === "/api/session.json") {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify(session));
				return;
			}
			viteDevServer.middlewares(request, response, () => {
				response.statusCode = 404;
				response.end("Not found");
			});
		});

		await new Promise<void>((resolve) => httpServer.listen(requestedPort, resolve));
		const address = httpServer.address();
		const port: number = typeof address === "object" && address !== null ? address.port : requestedPort;

		process.on("SIGINT", () => {
			httpServer.close();
			void viteDevServer.close().finally(() => process.exit(0));
		});

		return `http://localhost:${port}/`;
	}

	private static _openBrowser(url: string): void {
		const openCommandByPlatform: Record<string, string> = { darwin: "open", win32: "start" };
		const openCommand: string = openCommandByPlatform[process.platform] ?? "xdg-open";
		NodeChildProcess.spawn(openCommand, process.platform === "win32" ? ["", url] : [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

if (process.argv[1] && NodeUrl.fileURLToPath(import.meta.url) === process.argv[1]) {
	void MainHelper.run();
}
