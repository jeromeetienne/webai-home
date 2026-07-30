import { PipelineSpecificationSchema, type PipelineSpecification, type StageName, type TaskInput } from "@webai/protocol";

/** Holds validated pipeline definitions. Versions are immutable once a task selects one. */
export class PipelineRegistry {
  private readonly specifications = new Map<string, PipelineSpecification>();

  constructor(specifications: PipelineSpecification[]) {
    for (const specification of specifications) this.add(specification);
  }

  add(value: unknown): PipelineSpecification {
    const specification = PipelineSpecificationSchema.parse(value);
    const key = this.key(specification.pipelineId, specification.version);
    if (this.specifications.has(key)) throw new Error(`Pipeline ${specification.pipelineId}@${specification.version} is already registered`);
    this.specifications.set(key, specification);
    return specification;
  }

  select(input: TaskInput, pipelineId?: string, pipelineVersion?: number): PipelineSpecification | undefined {
    const candidates = [...this.specifications.values()]
      .filter((specification) => specification.taskType === input.taskType && !specification.retired)
      .filter((specification) => pipelineId === undefined || specification.pipelineId === pipelineId)
      .filter((specification) => pipelineVersion === undefined || specification.version === pipelineVersion)
      .sort((left, right) => right.version - left.version);
    return candidates[0];
  }

  get(pipelineId: string, version: number): PipelineSpecification | undefined { return this.specifications.get(this.key(pipelineId, version)); }
  list(): PipelineSpecification[] { return [...this.specifications.values()]; }

  /**
   * Reports whether any pipeline that is still in use defines a stage.
   *
   * The registry is the authority on which stage names exist. `StageName` in the shared
   * protocol package only checks the shape of a name, so a worker advertising a stage no
   * pipeline defines is caught here rather than by schema validation.
   *
   * @param stageName - The stage name to look for.
   * @returns `true` when a pipeline that is not retired lists the stage.
   */
  definesStage(stageName: StageName): boolean {
    return this.list().some((specification) => specification.retired !== true && specification.stages.some((stage) => stage.name === stageName));
  }

  /**
   * Lists every stage name defined by a pipeline that is still in use.
   *
   * @returns The stage names, without repetition.
   */
  stageNames(): StageName[] {
    return [...new Set(this.list().filter((specification) => specification.retired !== true).flatMap((specification) => specification.stages.map((stage) => stage.name)))];
  }

  private key(pipelineId: string, version: number): string { return `${pipelineId}\u0000${version}`; }
}

/**
 * The pipelines the gateway knows without being given a pipeline file.
 *
 * These are ordinary specifications with no privileged status. The gateway advances a task
 * through the stages its pipeline lists, and a worker runs the computation each stage names,
 * so replacing either of these through `--pipeline-file` needs no change to the source.
 */
export const builtinPipelineSpecifications: PipelineSpecification[] = [
  {
    pipelineId: "dev_formula", version: 1, taskType: "task_type_dev_formula",
    stages: [
      { name: "stage_dev_formula_multiply", computation: "dev_formula_multiply", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" },
      { name: "stage_dev_formula_add", computation: "dev_formula_add", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" },
    ],
  },
  {
    // The three shards run once per generated token, so this pipeline repeats until a shard
    // result reports that generation is done. All shards of one task stay on one device, so
    // the worker keeps its key-value cache in memory between rounds instead of sending it
    // over the connection; that is what prefersSameWorkerOnRetry protects when an attempt is
    // retried.
    pipelineId: "llm_qwen3_0_6b_sharded", version: 1, taskType: "task_type_llm_qwen3_0_6b_sharded", repeatsUntilDone: true,
    stages: [
      { name: "stage_llm_qwen3_0_6b_shard1of3", computation: "llm_qwen3_0_6b_shard", inputSchemaId: "llm@1", outputSchemaId: "llm@1", encoding: "inline-json", prefersSameWorkerOnRetry: true },
      { name: "stage_llm_qwen3_0_6b_shard2of3", computation: "llm_qwen3_0_6b_shard", inputSchemaId: "llm@1", outputSchemaId: "llm@1", encoding: "inline-json", prefersSameWorkerOnRetry: true },
      { name: "stage_llm_qwen3_0_6b_shard3of3", computation: "llm_qwen3_0_6b_shard", inputSchemaId: "llm@1", outputSchemaId: "llm@1", encoding: "inline-json", prefersSameWorkerOnRetry: true },
    ],
  },
  {
    // Chrome's built-in language model is asked for an answer once and then delivers it in
    // pieces, so this pipeline runs its single stage once per piece: the stage returns the
    // answer so far and the pipeline repeats until the stage reports generation finished.
    // The open generation lives in the memory of the device that started it, which is why
    // the stage prefers that same device when an attempt is retried. The lease is longer
    // than the gateway default because creating the model session on a device that has just
    // downloaded the model can take far longer than reading one piece of the answer.
    pipelineId: "llm_gemma_nano_chrome_full", version: 1, taskType: "task_type_llm_gemma_nano_chrome_full", repeatsUntilDone: true,
    stages: [
      { name: "stage_llm_gemma_nano_chrome_full", computation: "llm_gemma_nano_chrome_full", inputSchemaId: "llm@1", outputSchemaId: "llm@1", encoding: "inline-json", leaseMs: 60_000, prefersSameWorkerOnRetry: true },
    ],
  },
];
