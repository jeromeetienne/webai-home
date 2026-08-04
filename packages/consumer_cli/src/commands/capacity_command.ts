import type { Device, PipelineSpecification, TaskType } from '@webai/protocol';
import { GatewaySession } from '../gateway_connection/gateway_session.js';
import { CapacityCalculator } from '../cluster_capacity/capacity_calculator.js';
import { TaskInputFactory, taskTypeNames } from '../libs/task_input_factory.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CapacityCommand — estimates how many concurrent runs of a task type the cluster supports
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The ways `capacity` can write its estimate out. */
export type CapacityFormat = 'text' | 'markdown' | 'json';

/** Every format `capacity` accepts, in the order the help text lists them. */
export const capacityFormats: CapacityFormat[] = ['text', 'markdown', 'json'];

/** What `consumer_cli capacity --task_type <type>` needs to connect and what to estimate capacity for. */
export type CapacityCommandOptions = {
	url: string;
	authToken: string;
	timeoutMs: number;
	/** A task type name, spelled the same way as `submit`'s `-t/--task_type` (without `task_type_`). */
	type: string;
	format: CapacityFormat;
};

/** The capacity estimate `capacity` prints, either as a sentence, a Markdown document, or JSON. */
type CapacityResult = {
	type: string;
	pipelineId: string;
	pipelineVersion: number;
	capacity: number;
	reason: string;
};

/**
 * Connects to the central gateway as an observer, fetches the connected devices and the
 * registered pipelines, and estimates how many concurrent runs of one task type the cluster
 * can currently support, using `CapacityCalculator`.
 */
export class CapacityCommand {
	/**
	 * @param options Where to connect and which task type to estimate capacity for.
	 * @throws {Error} If `type` names no task type, or no pipeline serves it.
	 * @throws {CliError} If the connection, authentication, or the device or pipeline
	 * snapshot fails.
	 */
	static async run(options: CapacityCommandOptions): Promise<void> {
		if (TaskInputFactory.isTaskTypeName(options.type) === false) throw new Error(`Type must be one of ${taskTypeNames.join(', ')}`);
		const taskType = `task_type_${options.type}` as TaskType;

		let devices: Device[] = [];
		let pipelines: PipelineSpecification[] = [];
		const session = await GatewaySession.connect({
			url: options.url,
			authToken: options.authToken,
			timeoutMs: options.timeoutMs,
			onDevices: (received): void => { devices = received; },
			onPipelines: (received): void => { pipelines = received; },
		});
		session.close();

		const pipeline = CapacityCommand._selectPipeline(pipelines, taskType);
		if (pipeline === undefined) throw new Error(`No pipeline is registered for task type ${options.type}`);

		const estimate = CapacityCalculator.calculate(pipeline, devices);
		const result: CapacityResult = {
			type: options.type,
			pipelineId: pipeline.pipelineId,
			pipelineVersion: pipeline.version,
			capacity: estimate.capacity,
			reason: estimate.reason,
		};
		console.log(CapacityCommand._format(result, options.format));
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Formatting
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reports whether a string names a format this class can write.
	 *
	 * @param value The value to check, as typed on the command line.
	 * @returns `true` when the value names a format.
	 */
	static isFormat(value: string): value is CapacityFormat {
		return (capacityFormats as string[]).includes(value);
	}

	/**
	 * Writes a capacity estimate out in the requested format.
	 *
	 * @param result The capacity estimate to print.
	 * @param format Which format to write.
	 * @returns The estimate as one string, ready to print.
	 */
	private static _format(result: CapacityResult, format: CapacityFormat): string {
		if (format === 'json') {
			return JSON.stringify(result, null, 2);
		}
		if (format === 'markdown') {
			return CapacityCommand._formatMarkdown(result);
		}
		return CapacityCommand._formatHuman(result);
	}

	/**
	 * Formats a capacity estimate as the human-readable sentence `capacity` prints by default.
	 *
	 * @param result The capacity estimate to print.
	 * @returns The sentence text, ready to print with a single `console.log`.
	 */
	private static _formatHuman(result: CapacityResult): string {
		return `${result.type}: ${result.capacity} concurrent run${result.capacity === 1 ? '' : 's'} supported\n`
			+ `  limited by: ${result.reason}`;
	}

	/**
	 * Formats a capacity estimate as a Markdown document.
	 *
	 * @param result The capacity estimate to print.
	 * @returns The Markdown text, ready to print with a single `console.log`.
	 */
	private static _formatMarkdown(result: CapacityResult): string {
		const lines: string[] = [];
		lines.push('# Capacity estimate');
		lines.push('');
		lines.push(`- **Task type:** ${result.type}`);
		lines.push(`- **Pipeline:** ${result.pipelineId} (version ${result.pipelineVersion})`);
		lines.push(`- **Capacity:** ${result.capacity} concurrent run${result.capacity === 1 ? '' : 's'} supported`);
		lines.push(`- **Limited by:** ${result.reason}`);
		return lines.join('\n');
	}

	/**
	 * Picks the pipeline `capacity` estimates against, the same way the gateway's own
	 * `PipelineRegistry.select` picks one to run a submitted task through: the highest
	 * version, among pipelines that are not retired.
	 *
	 * @param pipelines Every pipeline the central gateway holds.
	 * @param taskType The task type to find a pipeline for.
	 * @returns The selected pipeline, or `undefined` when none matches.
	 */
	private static _selectPipeline(pipelines: PipelineSpecification[], taskType: TaskType): PipelineSpecification | undefined {
		return pipelines
			.filter((pipeline) => pipeline.taskType === taskType && pipeline.retired !== true)
			.sort((left, right) => right.version - left.version)[0];
	}
}
