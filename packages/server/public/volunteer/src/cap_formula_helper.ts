import type { StageName } from "@webai/protocol";

/** Formula-stage capabilities and computation for a volunteer browser. */
export class CapFormulaHelper {
	/** The capabilities advertised to the central server for the formula stages. */
	static readonly capabilities: [string, string] = ["cap_formula_multiply", "cap_formula_add"];

	/**
	 * Computes the result of a formula stage for a given input value.
	 *
	 * @param stage The formula stage to compute.
	 * @param value The input value for the stage.
	 * @returns The computed result for the stage.
	 */
	static compute(stage: StageName, value: number): number {
		return stage === "multiply" ? value * 2 : value + 7;
	}
}
