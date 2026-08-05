///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LmstudioExampleResultsTable — collects one row per model and prints them as a table
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one model did with one of the things an example checks. */
export type ExampleOutcome =
	/** The model did it. */
	| 'yes'
	/** The model did not do it. */
	| 'no'
	/** An earlier step already failed, so this one was never tried. */
	| 'not reached'
	/** LM Studio refused the request or the request could not be made at all. */
	| 'failed';

/** What one model did with everything an example checks, and which model actually answered. */
export type ExampleModelResult = {
	/**
	 * The model identifier LM Studio reported in its answer, which is not always the one that was
	 * asked for: LM Studio answers an unknown identifier with whichever model it currently holds in
	 * memory, rather than refusing the request.
	 */
	answeredByModelId: string;
	/** What the model did with each of the things the example checks, in the order of the columns. */
	outcomes: ExampleOutcome[];
};

/**
 * Collects the outcome of every model an example ran against, then prints them all as one table.
 *
 * The table is the point of these examples: reading one model's output tells you little, and what
 * is wanted is which models support conversation history and which models support tools. The table
 * holds the rows gathered so far, so it has state and its methods are instance methods.
 */
export class LmstudioExampleResultsTable {
	/** One row per model, in the order the models were run. */
	private readonly rows: string[][] = [];

	/**
	 * @param columnTitles The title of every column, the first of which names the model column.
	 */
	constructor(private readonly columnTitles: string[]) {
	}

	/**
	 * Adds the row of one model.
	 *
	 * @param modelId The model this row is about, named as LM Studio names it.
	 * @param outcomes What the model did with each of the things the example checks, in the order
	 * of the column titles that follow the model column.
	 * @returns Nothing.
	 */
	addRow(modelId: string, outcomes: ExampleOutcome[]): void {
		this.rows.push([modelId, ...outcomes]);
	}

	/**
	 * Names the model a row is about, saying so plainly when the model that answered is not the
	 * model that was asked for.
	 *
	 * @param requestedModelId The model identifier the request named.
	 * @param answeredByModelId The model identifier LM Studio reported in its answer.
	 * @returns What to put in the model column of that row.
	 */
	static modelLabel(requestedModelId: string, answeredByModelId: string): string {
		if (answeredByModelId === '' || answeredByModelId === requestedModelId) {
			return requestedModelId;
		}
		return `${requestedModelId} (answered by ${answeredByModelId})`;
	}

	/**
	 * Prints every row gathered so far as a table, with each column widened to its widest cell.
	 *
	 * @returns Nothing.
	 */
	print(): void {
		const allRows = [this.columnTitles, ...this.rows];
		const columnWidths = this.columnTitles.map((_, columnIndex) => {
			return Math.max(...allRows.map((row) => (row[columnIndex] ?? '').length));
		});
		const lineOf = (row: string[]): string => {
			const cells = columnWidths.map((width, columnIndex) => (row[columnIndex] ?? '').padEnd(width));
			return `| ${cells.join(' | ')} |`;
		};
		const separator = `|${columnWidths.map((width) => '-'.repeat(width + 2)).join('|')}|`;

		console.log('');
		console.log(lineOf(this.columnTitles));
		console.log(separator);
		for (const row of this.rows) {
			console.log(lineOf(row));
		}
	}
}
