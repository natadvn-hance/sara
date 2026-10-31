import { sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { activeRules, insertVersion } from '../direction/store'

/**
 * «Минимальный балл» in the settings (M7 design 6.4, pult v2 design 8). The threshold is part of the rules of the
 * direction, so a change is a new version of them, made under the direction's lock and only from the version Boris
 * saw. The hint is counted on the scores already stored for the last seven days, without a model call.
 */

const WEEK_MS = 7 * 24 * 3600_000

export const THRESHOLD_TEXTS = {
  stale: 'Правила изменились, пока экран был открыт. Открой настройки заново.',
  same: 'Порог тот же, менять нечего.',
  saved: (from: number, to: number, version: number) =>
    `Порог ${from} → ${to}. Это правила v${version}, прошлую версию можно вернуть.`,
} as const

export type ThresholdHint = {
  value: number
  current: number
  version: number
  /** Cards of the last seven days at the current threshold, and at the new one. */
  cardsNow: number
  cardsWould: number
  /** Boris's «да» that the new threshold would have lost, and his «нет» it would have brought. */
  lostYes: number
  gainedNo: number
}

export async function thresholdHint(
  db: DbOrTx,
  accountId: string,
  value: number,
  now = new Date(),
): Promise<ThresholdHint> {
  const active = await activeRules(db as Db, accountId)
  const current = active.rules.threshold
  const since = new Date(now.getTime() - WEEK_MS).toISOString()
  const r = await db.execute<{ score: number; label: string | null }>(sql`
    select s.score, lb.label
    from core.lead l
    join lateral (
      select score, stop_factor from core.lead_score
      where lead_id = l.id and not backtest order by created_at desc limit 1
    ) s on true
    left join core.lead_label lb on lb.lead_id = l.id
    where l.account_id = ${accountId} and l.seen_at >= ${since} and s.stop_factor is null`)
  const rows = r.rows
  const at = (t: number) => rows.filter((x) => x.score >= t)
  const yes = (x: { label: string | null }) => x.label === 'yes'
  const no = (x: { label: string | null }) => x.label === 'no' || x.label === 'weak_no'
  return {
    value,
    current,
    version: active.version,
    cardsNow: at(current).length,
    cardsWould: at(value).length,
    lostYes: rows.filter((x) => yes(x) && x.score >= current && x.score < value).length,
    gainedNo: rows.filter((x) => no(x) && x.score < current && x.score >= value).length,
  }
}

/** A new version of the rules with only the threshold changed, from the version Boris saw. */
export async function setThreshold(
  db: Db,
  accountId: string,
  value: number,
  expectedVersion: number,
): Promise<{ ok: boolean; message: string; version?: number }> {
  return db.transaction(async (tx) => {
    // The same lock insertVersion takes, held from the read: no other version comes in between.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`direction:${accountId}`}))`)
    const active = await activeRules(tx, accountId)
    if (active.version !== expectedVersion) return { ok: false, message: THRESHOLD_TEXTS.stale }
    const from = active.rules.threshold
    if (from === value) return { ok: false, message: THRESHOLD_TEXTS.same }
    const version = await insertVersion(tx, {
      accountId,
      rules: { ...active.rules, threshold: value },
      createdBy: 'boris',
      reason: `Порог ${from} → ${value} из настроек`,
    })
    return { ok: true, message: THRESHOLD_TEXTS.saved(from, value, version), version }
  })
}
