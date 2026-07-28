import NodeFs from "node:fs";
import NodePath from "node:path";
import NodeUrl from "node:url";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CleanLogs — deletes every participant's message log file
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Deletes every `.jsonl` message log file written by any participant — the
 * gateway's own log, the relayed worker logs it keeps alongside its own, and
 * the consumer logs — so a fresh capture starts from a clean slate
 * instead of flow_viewer picking up stale traffic from earlier runs.
 */
export class CleanLogs {
	private static readonly LOG_DIRECTORIES: readonly string[] = [
		NodeUrl.fileURLToPath(new URL("../../gateway/logs", import.meta.url)),
		NodeUrl.fileURLToPath(new URL("../../consumer/logs", import.meta.url)),
	];

	static run(): void {
		const removedCount: number = CleanLogs.LOG_DIRECTORIES.reduce((sum: number, logsDirectory: string): number => sum + CleanLogs._cleanDirectory(logsDirectory), 0);
		console.log(`Removed ${removedCount} log file(s).`);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	private static _cleanDirectory(logsDirectory: string): number {
		if (!NodeFs.existsSync(logsDirectory)) return 0;

		const logFileNames: string[] = NodeFs.readdirSync(logsDirectory).filter((fileName: string): boolean => fileName.endsWith(".jsonl"));
		for (const fileName of logFileNames) {
			const filePath: string = NodePath.join(logsDirectory, fileName);
			NodeFs.unlinkSync(filePath);
			console.log(`Removed ${filePath}`);
		}
		return logFileNames.length;
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

if (process.argv[1] && NodeUrl.fileURLToPath(import.meta.url) === process.argv[1]) {
	CleanLogs.run();
}
