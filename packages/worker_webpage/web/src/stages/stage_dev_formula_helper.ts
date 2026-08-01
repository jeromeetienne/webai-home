///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageDevFormulaHelper — runs the development formula stages in a worker browser
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Formula-stage capabilities and computation for a worker browser. */
export class StageDevFormulaHelper {
	/**
	 * The computations this worker browser implements, named the way a pipeline stage names
	 * its computation.
	 *
	 * A stage is dispatched by its computation, not by its stage name, so a pipeline added
	 * through the gateway's `--pipeline-file` option may introduce a new stage name that
	 * reuses one of these computations without this browser being changed or rebuilt.
	 */
	static readonly computations: string[] = ['dev_formula_multiply', 'dev_formula_add'];

	/**
	 * Reports whether this helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return StageDevFormulaHelper.computations.includes(computation);
	}

	/**
	 * Computes the result of a formula stage for a given input value.
	 *
	 * @param computation The computation named by the assigned stage.
	 * @param value The input value for the stage.
	 * @returns The computed result for the stage.
	 * @throws If the computation is not one this browser implements.
	 */
	static compute(computation: string, value: number): number {
		if (computation === 'dev_formula_multiply') {
			return value * 2;
		}
		if (computation === 'dev_formula_add') {
			return value + 7;
		}
		throw new Error(`This browser does not implement the computation ${computation}.`);
	}
}
