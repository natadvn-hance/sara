import type { DirectionRules } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../../src/db/client'
import { lead } from '../../src/db/schema'
import { calibrationView, markItem, startCalibration } from '../../src/direction/calibration'
import { runWorker } from '../../src/direction/runs'
import { RULES_V1 } from '../../src/direction/v1'
import { fakeGateway } from './gateway'
import { leadWithScore } from './learning'
import { scorerAnswer } from './scorer'

export const idOf = (i: number) => String(971000 + i)

/** Leads with these live scores, newest first; the ids are 971000 and up (from `first` on). */
export async function leadsWith(db: Db, scores: number[], first = 0) {
  for (const [k, score] of scores.entries()) {
    const i = first + k
    await leadWithScore(db, idOf(i), score)
    await db
      .update(lead)
      .set({ seenAt: new Date(Date.now() - i * 60_000).toISOString(), status: 'scored_out' })
      .where(eq(lead.id, idOf(i)))
  }
}

/**
 * A finished calibration: `boris` marks one per lead (in the run's order), `sara` is one score per lead in the same
 * order (70 shows a lead, 30 drops it, neither is near the threshold of 56 that would ask the stronger model too).
 */
export async function calibrate(
  db: Db,
  accountId: string,
  boris: ('yes' | 'no' | 'unsure')[],
  sara: number[],
  rules: DirectionRules = RULES_V1,
) {
  await leadsWith(
    db,
    Array.from({ length: boris.length }, () => 60),
  )
  const r = await startCalibration(db, { accountId, rules })
  if (!r.ok) throw new Error('no run')
  const ids = (await calibrationView(db, r.runId)).items.map((i) => i.leadId)
  for (const [i, id] of ids.entries()) await markItem(db, r.runId, id, boris[i] ?? 'unsure')
  const f = await fakeGateway(db, { scorer: { $sequence: sara.map((v) => scorerAnswer(v)) } })
  await runWorker({ db, ...f }, r.runId)
  return { runId: r.runId, ids }
}
