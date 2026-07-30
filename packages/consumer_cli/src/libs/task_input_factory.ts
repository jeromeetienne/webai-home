import type { TaskInput } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TaskInputFactory — builds the task input a consumer submits, from command line text
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The task types a consumer may submit, each named as its task type without the leading
 * `task_type_`. This is the list the `-t/--type` command line option accepts.
 */
export const taskTypeNames = ['dev_formula', 'llm_qwen3_0_6b_sharded', 'llm_gemma_nano_chrome_full'] as const;

/** One of the task types a consumer may submit. */
export type TaskTypeName = typeof taskTypeNames[number];

/**
 * Turns the text given on the command line into the task input the gateway expects.
 *
 * Every task type carries a different kind of value — a number for the development formula
 * task, and a prompt for either language-model task — so the checking of that value lives
 * here, next to the list of task types it belongs to.
 */
export class TaskInputFactory {
	/**
	 * Reports whether a value names a task type a consumer may submit.
	 *
	 * @param value The value given on the command line.
	 * @returns `true` when it is one of `taskTypeNames`.
	 */
	static isTaskTypeName(value: string): value is TaskTypeName {
		return (taskTypeNames as readonly string[]).includes(value);
	}

	/**
	 * Builds the task input for one task type, checking the value it carries.
	 *
	 * @param type The task type to submit, without the leading `task_type_`.
	 * @param value The value submitted with the task: a number for the development formula
	 * task, and a prompt for either language-model task.
	 * @returns The task input to submit to the gateway.
	 */
	static createTaskInput(type: TaskTypeName, value: string | undefined): TaskInput {
		if (type === 'dev_formula') return { taskType: 'task_type_dev_formula', input: TaskInputFactory.parseFormulaInput(value) };
		if (type === 'llm_qwen3_0_6b_sharded') return { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: TaskInputFactory.parseLlmInput(value) };
		return { taskType: 'task_type_llm_gemma_nano_chrome_full', input: TaskInputFactory.parseLlmInput(value) };
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Value Checks
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the value of a development formula task as a number.
	 *
	 * @param value The value given on the command line.
	 * @returns The number the development formula task is computed from.
	 */
	private static parseFormulaInput(value: string | undefined): number {
		const input = Number(value);
		if (Number.isFinite(input) === false) throw new Error('Input must be a finite number');
		return input;
	}

	/**
	 * Reads the value of a language-model task as a prompt.
	 *
	 * @param value The value given on the command line.
	 * @returns The prompt the language-model task answers, with its surrounding spaces kept.
	 */
	private static parseLlmInput(value: string | undefined): string {
		if (typeof value !== 'string' || value.trim() === '') throw new Error('Input must be a non-empty string');
		return value;
	}
}
