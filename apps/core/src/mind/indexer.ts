import type { Db } from '../db/client'

/** Rebuilds core.mind_index from the mind folder when its version changed (FR-MIND-2). Part B writes the body. */
export async function ensureMindIndex(
  _db: Db,
  _mindDir: string,
): Promise<{ mindVersion: string; records: number; changed: boolean }> {
  return { mindVersion: 'empty', records: 0, changed: false }
}
