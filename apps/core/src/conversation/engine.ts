import type { EngineDeps, TurnInput, TurnPlan } from './types'

/** Steps 2-6 of a turn: recall, understand and say, check, rules (FR-CONV-3). Part C writes the body. */
export async function planTurn(_deps: EngineDeps, _input: TurnInput): Promise<TurnPlan> {
  throw new Error('engine is not built')
}
