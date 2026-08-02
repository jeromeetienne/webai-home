import type { Device, PipelineSpecification, TaskType } from '@webai/protocol';
import { GatewaySession } from '../gateway_connection/gateway_session.js';
import { CapacityCalculator } from '../cluster_capacity/capacity_calculator.js';
import { TaskInputFactory, taskTypeNames } from '../libs/task_input_factory.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CapacityCommand — estimates how many concurrent runs of a task type the cluster supports
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `consumer_cli capacity --task_type <type>` needs to connect and what to estimate capacity for. */
export type CapacityCommandOptions = {
	url: string;
	authToken: string;
	timeoutMs: number;
	/** A task type name, spelled the same way as `submit`'s `-t/--task_type` (without `task_type_`). */
	type: string;
	json: boolean;
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

		const result = CapacityCalculator.calculate(pipeline, devices);
		if (options.json) {
			console.log(JSON.stringify({ type: options.type, pipelineId: pipeline.pipelineId, pipelineVersion: pipeline.version, capacity: result.capacity, reason: result.reason }, null, 2));
			return;
		}
		console.log(`${options.type}: ${result.capacity} concurrent run${result.capacity === 1 ? '' : 's'} supported`);
		console.log(`  limited by: ${result.reason}`);
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
