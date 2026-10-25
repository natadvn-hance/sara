import { desc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { lead } from '../db/schema'
import { getSetting } from '../settings/store'
import type { Profile, ProfilePatch } from './profile'

export type Contradiction = {
  id: string
  text: string
  /** What the profile itself can change to remove it; the money settings are not the profile's, so none. */
  fix: { label: string; patch: ProfilePatch } | null
}

const FEES_LOOKED_AT = 50

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] ?? 0) : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2)
}

/**
 * Step 7 of the onboarding (FR-ACC-3): the speed and money the direction is set to, checked against each other in
 * plain code (no model). Each finding is one plain sentence, with a fix when the profile can make it.
 */
export async function contradictions(
  d: { db: DbOrTx },
  accountId: string,
  p: Pick<Profile, 'speed' | 'reply_format' | 'cases'>,
): Promise<Contradiction[]> {
  const out: Contradiction[] = []
  const budget = await getSetting(d.db, 'money.daily_budget_rub')
  const ceiling = await getSetting(d.db, 'money.max_fee_rub')
  if (budget !== null && ceiling !== null && budget < ceiling)
    out.push({
      id: 'budget_below_ceiling',
      text: `Бюджет на день ${budget} ₽ меньше потолка одного отклика ${ceiling} ₽: ни один дорогой отклик не пройдёт.`,
      fix: null,
    })
  if (ceiling !== null) {
    const fees = await d.db
      .select({ fee: lead.bidPriceRub })
      .from(lead)
      .where(eq(lead.accountId, accountId))
      .orderBy(desc(lead.seenAt))
      .limit(FEES_LOOKED_AT)
    const usual = fees.length > 0 ? median(fees.map((f) => f.fee)) : null
    if (usual !== null && ceiling < usual)
      out.push({
        id: 'ceiling_below_fee',
        text: `Потолок за отклик ${ceiling} ₽ ниже обычной цены отклика (${usual} ₽ по последним заявкам): большинство откликов не уйдёт.`,
        fix: null,
      })
  }
  if (p.speed === 'fast' && !(await getSetting(d.db, 'outbound.bids')))
    out.push({
      id: 'fast_without_bids',
      text: 'Быстрый режим при выключенных откликах: заявка придёт со звуком, а отклик всё равно не уйдёт.',
      fix: { label: 'Обычная скорость', patch: { speed: 'normal' } },
    })
  const bids = await getSetting(d.db, 'money.daily_bids')
  const cards = await getSetting(d.db, 'cards.max_per_day')
  if (bids > cards)
    out.push({
      id: 'bids_over_cards',
      text: `Откликов в день разрешено ${bids}, а карточек в день не больше ${cards}: лишнее разрешение ничего не даст.`,
      fix: null,
    })
  if (p.reply_format && p.reply_format.max_cases > 0 && p.cases.length === 0)
    out.push({
      id: 'cases_empty',
      text: 'В отклик разрешены кейсы, а библиотека кейсов пуста.',
      fix: { label: 'Без кейсов', patch: { reply_format: { ...p.reply_format, max_cases: 0 } } },
    })
  return out
}
