import type { Db } from '../db/client'
import type { NightJob, SchoolDeps } from './types'

/** Runs the night jobs whose time has come, once a night, within the budget (NFR-COST-2). Part H writes the body. */
export async function runNight(
  _d: SchoolDeps,
  _jobs: NightJob[],
  _now: Date,
): Promise<{ ran: string[]; skipped: { name: string; reason: string }[] }> {
  return { ran: [], skipped: [] }
}

/** Units the night school has spent since the window opened. Part H writes the body. */
export async function nightUnitsUsed(_db: Db, _now: Date): Promise<number> {
  return 0
}
