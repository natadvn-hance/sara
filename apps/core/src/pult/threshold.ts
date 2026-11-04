import { LEAD_KIND_TITLES, LEAD_KINDS, type LeadKind, leadKind } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { activeRules, insertVersion } from '../direction/store'

/**
 * «Минимальный балл» in the settings by the kind of the order: marketing, sites, the rest (M7 design 6.4, pult v2
 * design 8, 3.11 Boris: «мы в первую очередь маркетинг»). The thresholds are part of the rules of the direction, so
 * a change is a new version of them, made under the direction's lock and only from the version Boris saw. The hint
 * is counted on the scores already stored for the last seven days, without a model call.
 */

const WEEK_MS = 7 * 24 * 3600_000

export type Thresholds = Record<LeadKind, number>

export const THRESHOLD_TEXTS = {
  stale: 'Правила изменились, пока экран был открыт. Открой настройки заново.',
  same: 'Пороги те же, менять нечего.',
  saved: (from: Thresholds, to: Thresholds, version: number) =>
    `${LEAD_KINDS.filter((k) => from[k] !== to[k])
      .map((k) => `${LEAD_KIND_TITLES[k]} ${from[k]} → ${to[k]}`)
      .join(', ')}. Это правила v${version}, прошлую версию можно вернуть.`,
} as const

export type KindHint = {
  value: number
  current: number
  /** Cards of the last seven days at the current threshold, and at the new one. */
  cardsNow: number
  cardsWould: number
  /** Boris's «да» that the new threshold would have lost, and his «нет» it would have brought. */
  lostYes: number
  gainedNo: number
}

export type ThresholdHint = { version: number; kinds: Record<LeadKind, KindHint> }

/** The thresholds in force: a kind the rules do not set takes the plain threshold. */
export function thresholdsOf(rules: {
  threshold: number
  kind_thresholds?: Partial<Thresholds>
}): Thresholds {
  return {
    marketing: rules.kind_thresholds?.marketing ?? rules.threshold,
    sites: rules.kind_thresholds?.sites ?? rules.threshold,
    other: rules.kind_thresholds?.other ?? rules.threshold,
  }
}

export async function thresholdHint(
  db: DbOrTx,
  accountId: string,
  values: Thresholds,
  now = new Date(),
): Promise<ThresholdHint> {
  const active = await activeRules(db as Db, accountId)
  const current = thresholdsOf(active.rules)
  const since = new Date(now.getTime() - WEEK_MS).toISOString()
  const r = await db.execute<{ score: number; label: string | null; category: string }>(sql`
    select s.score, lb.label, l.category
    from core.lead l
    join lateral (
      select score, stop_factor from core.lead_score
      where lead_id = l.id and not backtest order by created_at desc limit 1
    ) s on true
    left join core.lead_label lb on lb.lead_id = l.id
    where l.account_id = ${accountId} and l.seen_at >= ${since} and s.stop_factor is null`)
  const yes = (x: { label: string | null }) => x.label === 'yes'
  const no = (x: { label: string | null }) => x.label === 'no' || x.label === 'weak_no'
  const kinds = {} as Record<LeadKind, KindHint>
  for (const k of LEAD_KINDS) {
    const rows = r.rows.filter((x) => leadKind(x.category) === k)
    const at = (t: number) => rows.filter((x) => x.score >= t)
    kinds[k] = {
      value: values[k],
      current: current[k],
      cardsNow: at(current[k]).length,
      cardsWould: at(values[k]).length,
      lostYes: rows.filter((x) => yes(x) && x.score >= current[k] && x.score < values[k]).length,
      gainedNo: rows.filter((x) => no(x) && x.score < current[k] && x.score >= values[k]).length,
    }
  }
  return { version: active.version, kinds }
}

/** A new version of the rules with only the thresholds changed, from the version Boris saw. */
export async function setThresholds(
  db: Db,
  accountId: string,
  values: Thresholds,
  expectedVersion: number,
): Promise<{ ok: boolean; message: string; version?: number }> {
  return db.transaction(async (tx) => {
    // The same lock insertVersion takes, held from the read: no other version comes in between.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`direction:${accountId}`}))`)
    const active = await activeRules(tx, accountId)
    if (active.version !== expectedVersion) return { ok: false, message: THRESHOLD_TEXTS.stale }
    const from = thresholdsOf(active.rules)
    if (LEAD_KINDS.every((k) => from[k] === values[k]))
      return { ok: false, message: THRESHOLD_TEXTS.same }
    const version = await insertVersion(tx, {
      accountId,
      // The plain threshold follows «Остальное»: whatever reads only it sees the rest's bar.
      rules: { ...active.rules, threshold: values.other, kind_thresholds: values },
      createdBy: 'boris',
      reason: `Пороги ${LEAD_KINDS.map((k) => `${LEAD_KIND_TITLES[k]} ${from[k]} → ${values[k]}`).join(', ')} из настроек`,
    })
    return { ok: true, message: THRESHOLD_TEXTS.saved(from, values, version), version }
  })
}
