import type { MindChange } from '../school/types'

/** The file a change makes, and where it goes (M5 design 5.3). Part B writes the body. */
export function renderRecord(
  _c: MindChange,
  _current: { version: number; text: string; status: string } | null,
  _today: string,
): { target: string; text: string } {
  throw new Error('render is not built')
}
