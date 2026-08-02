import { z } from 'zod';
import { TaskType } from './task_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	PipelineTypes — the stage sequence a task runs, as stated by a pipeline specification
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The name of one stage of one pipeline.
 *
 * This is a bounded, pattern-checked string rather than a list of the stage names that
 * happen to exist today. Which stage names actually exist is decided at run time by the
 * pipeline specifications the gateway has loaded, so a new pipeline can be added through the
 * gateway's `--pipeline-file` option without changing this shared package and without
 * rebuilding the gateway, the worker, and the consumer together.
 *
 * A worker that advertises a stage no loaded pipeline defines is refused at registration, so
 * a mistyped name is still reported rather than silently never receiving work.
 */
export const StageName = z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/, 'A stage name must start with a lower-case letter and contain only lower-case letters, digits, and underscores');
/** The name of one step of one pipeline. */
export type StageName = z.infer<typeof StageName>;

/** One step of a pipeline: what it computes, what it accepts and returns, and how it is placed. */
export const PipelineStageSchema = z.object({
	name: StageName,
	/**
	 * Which computation a worker must run for this stage, such as `dev_formula_multiply` or
	 * `llm_qwen3_0_6b_shard`.
	 *
	 * The stage name identifies a step of one pipeline; the computation identifies the code
	 * that carries the step out. Separating the two is what lets a new pipeline reuse a
	 * computation a worker already ships, under a stage name that appears nowhere in the
	 * source. Every `stage.assign` carries this value, so a worker never has to recognise a
	 * stage name to know what to run.
	 */
	computation: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/, 'A computation name must start with a lower-case letter and contain only lower-case letters, digits, and underscores'),
	inputSchemaId: z.string().min(1).max(200),
	outputSchemaId: z.string().min(1).max(200),
	encoding: z.enum(['inline-json']),
	/**
	 * How long the assignment lease for this stage lasts, in milliseconds. A stage that does
	 * not state one uses the gateway's `--lease-ms` default. A worker extends the lease while
	 * it is still working by sending `stage.heartbeat`.
	 */
	leaseMs: z.number().int().positive().max(3_600_000).optional(),
	/**
	 * Whether a retry of this stage should go back to the worker that previously held it,
	 * rather than deliberately avoiding that worker. Set this for a stage that keeps state
	 * between assignments, such as a language-model shard holding a key-value cache, where
	 * moving the work to a different device throws that state away.
	 */
	prefersSameWorkerOnRetry: z.boolean().optional(),
}).strict();
/** One stage of one pipeline, as stated by its pipeline specification. */
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

/** A whole pipeline: which task kind it serves, and the ordered stages it runs. */
export const PipelineSpecificationSchema = z.object({
	pipelineId: z.string().min(1).max(200),
	version: z.number().int().positive(),
	taskType: TaskType,
	stages: z.array(PipelineStageSchema).min(1).max(20),
	/**
	 * Whether the pipeline runs its stages again from the first once the last stage finishes,
	 * instead of ending there.
	 *
	 * The language-model pipeline works this way: its shards run once per generated token, and
	 * generation ends when the last stage returns a result reporting `done: true`. A pipeline
	 * that does not state this runs each of its stages exactly once.
	 */
	repeatsUntilDone: z.boolean().optional(),
	retired: z.boolean().optional(),
}).strict().superRefine((specification, context) => {
	const names = specification.stages.map((stage) => stage.name);
	if (new Set(names).size !== names.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'A pipeline may not contain a stage more than once' });
});
/** A whole pipeline: which task kind it serves, and the ordered stages it runs. */
export type PipelineSpecification = z.infer<typeof PipelineSpecificationSchema>;
