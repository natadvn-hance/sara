import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import type { Db } from '../db/client'
import { examResult, examRun } from '../db/schema'

/**
 * What a run keeps about its scenarios, next to the versions of its roles in `exam_run.roles_version` (the one jsonb of
 * the run; the schema has no other and a migration is not made for this): the content hash of each scenario, and
 * whether the run was a part of the set. The next run finds in it which scenarios are unchanged since.
 */
export type RunMeta = { scenarios?: Record<string, string>; partial?: boolean }

/** A score that went through a 4-byte float column is the same score within this. */
export const SAME = 1e-6

/** The run a new run is compared with: the last one that passed. */
export type Baseline = {
  id: string
  score: number
  /** `same`: the same set. `overlap`: another set, compared on the scenarios whose content has not changed. */
  kind: 'same' | 'overlap'
  /** The score the baseline gave each scenario that is unchanged since, by id. */
  scores: Map<string, number>
}

const metaOf = (roles: unknown): RunMeta =>
  roles && typeof roles === 'object' ? (roles as RunMeta) : {}

const isJudgeKey = (key: string) => key.endsWith('+judge')

/** How many past passed runs are looked through for one that shares scenarios with this run. */
const LOOKED_AT = 50

/**
 * The last run that passed with the same set, else the last run that passed with a whole other set (not a part of it,
 * and with a judge that counts only if this one counts) that shares at least one unchanged scenario. A run that failed
 * is never a baseline. Null: there is nothing to compare with.
 */
export async function findBaseline(
  db: Db,
  o: { setKey: string; hashes: Map<string, string>; runId: string },
): Promise<Baseline | null> {
  const passed = await db
    .select({
      id: examRun.id,
      score: examRun.score,
      setKey: examRun.scenarioSet,
      roles: examRun.rolesVersion,
    })
    .from(examRun)
    .where(
      and(
        eq(examRun.passed, true),
        ne(examRun.id, o.runId),
        isNotNull(examRun.finishedAt),
        isNotNull(examRun.score),
      ),
    )
    .orderBy(desc(examRun.finishedAt), desc(examRun.startedAt))
    .limit(LOOKED_AT)
  const same = passed.find((r) => r.setKey === o.setKey)
  const candidates = same
    ? [same]
    : passed.filter(
        (r) => !metaOf(r.roles).partial && isJudgeKey(r.setKey) === isJudgeKey(o.setKey),
      )
  for (const c of candidates) {
    const theirs = metaOf(c.roles).scenarios
    // A run of the same set that kept no hashes holds every scenario as unchanged: the key says it is the same set.
    const unchanged = [...o.hashes].filter(([id, hash]) =>
      theirs ? theirs[id] === hash : c === same,
    )
    if (unchanged.length === 0 || c.score === null) continue
    const rows = await db
      .select({ id: examResult.scenarioId, score: examResult.score })
      .from(examResult)
      .where(
        and(
          eq(examResult.runId, c.id),
          inArray(
            examResult.scenarioId,
            unchanged.map(([id]) => id),
          ),
        ),
      )
    return {
      id: c.id,
      score: c.score,
      kind: c === same ? 'same' : 'overlap',
      scores: new Map(rows.map((r) => [r.id, r.score])),
    }
  }
  return null
}

/** The scenarios, unchanged since the baseline, whose score is now lower than it was. */
export function gotWorse(
  baseline: Baseline | null,
  now: { id: string; score: number }[],
): string[] {
  if (!baseline) return []
  return now
    .filter((r) => {
      const before = baseline.scores.get(r.id)
      return before !== undefined && r.score + SAME < before
    })
    .map((r) => r.id)
}
