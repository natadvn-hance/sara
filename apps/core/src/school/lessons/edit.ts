import type { EditWeight } from '../types'

/** How much Boris changed Sara's draft (M5 design 5.15). Part A writes the body. */
export function editWeight(
  _draft: string,
  _boris: string,
  _o: { substantialBelow: number; names: string[] },
): EditWeight {
  return 'minor'
}
