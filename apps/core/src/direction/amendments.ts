import type { DirectionRules } from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { directionVersion } from '../db/schema'
import { activeRules, insertVersion } from './store'

/** A change of the rules Boris asked for in words to a developer; its reason names it in the versions. */
export type Amendment = { reason: string; apply(r: DirectionRules): DirectionRules }

export const AMENDMENTS: Amendment[] = [
  {
    reason: 'Борис 24.10.2026: символический бюджет вроде 1 ₽ слегка снижает заявку',
    apply: (r) =>
      r.red_flags.some((f) => f.id === 'symbolic_budget')
        ? r
        : {
            ...r,
            red_flags: [
              ...r.red_flags,
              {
                id: 'symbolic_budget',
                text: 'Клиент указал символический бюджет, например 1 ₽: скорее всего, он хочет узнать цены или написал бюджет условно. Слегка снижает бюджетную зрелость, но сам по себе не причина отсеять.',
                soft: true,
              },
            ],
          },
  },
]

/**
 * Each amendment becomes Boris's new version once per account. One that was ever applied is not applied again,
 * so his later rollback stays (FR-MIND-3).
 */
export async function applyAmendments(
  db: Db,
  accountId: string,
  list: Amendment[] = AMENDMENTS,
): Promise<void> {
  for (const a of list) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`direction:${accountId}`}))`)
      const [done] = await tx
        .select({ v: directionVersion.version })
        .from(directionVersion)
        .where(
          and(eq(directionVersion.accountId, accountId), eq(directionVersion.reason, a.reason)),
        )
        .limit(1)
      if (done) return
      const active = await activeRules(tx, accountId)
      const rules = a.apply(active.rules)
      if (JSON.stringify(rules) === JSON.stringify(active.rules)) return
      await insertVersion(tx, { accountId, rules, createdBy: 'boris', reason: a.reason })
    })
  }
}
