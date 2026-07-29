import { PipelineSpecificationSchema, type PipelineSpecification, type TaskInput } from "@webai/protocol";

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
  private key(pipelineId: string, version: number): string { return `${pipelineId}\u0000${version}`; }
}

export const builtinPipelineSpecifications: PipelineSpecification[] = [
  {
    pipelineId: "formula", version: 1, taskType: "task_type_formula",
    stages: [
      { name: "stage_formula_multiply", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" },
      { name: "stage_formula_add", inputSchemaId: "number@1", outputSchemaId: "number@1", encoding: "inline-json" },
    ],
  },
];
