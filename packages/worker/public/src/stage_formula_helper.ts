import type { StageName } from "@webai/protocol";

/** Formula-stage capabilities and computation for a worker browser. */
export class StageFormulaHelper {
	/** The stages this worker browser supports, advertised to the central gateway. */
	static readonly stageNames: [StageName, StageName] = ["stage_formula_multiply", "stage_formula_add"];

	/**
	 * Computes the result of a formula stage for a given input value.
	 *
	 * @param stageName The formula stage to compute.
	 * @param value The input value for the stage.
	 * @returns The computed result for the stage.
	 */
	static compute(stageName: StageName, value: number): number {
		return stageName === "stage_formula_multiply" ? value * 2 : value + 7;
	}
}
