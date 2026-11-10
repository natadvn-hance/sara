import type { DbOrTx } from '../db/client'
import type { Share } from '../learning/precedents'
import { getSetting } from '../settings/store'

/**
 * The shadow of an auto-bid (Boris, 10.11.2026; docs/superpowers/specs/2026-11-10-shadow-autobid.md): his rule, «more
 * than 80% of bids on similar orders and a bid of 200 ₽ or less», checked on every card and only marked on it
 * («🤖 откликнулась бы сама») and in the journal. Nothing here sends a bid or spends money, whatever the settings:
 * a week of marks is compared with his own presses first.
 */

/** Why the rule did not fire, as codes (the journal keeps no words). */
export const AUTOBID_MISSES = [
  /** Fewer similar decisions than the minimum, so the share says nothing yet. */
  'few_similar',
  /** He bid on the similar orders not often enough. */
  'low_share',
  /** The bid's price is unknown (0). */
  'fee_unknown',
  /** The price was not read from the order page just before the card: it may be old. */
  'fee_not_fresh',
  /** The bid costs more than the ceiling. */
  'fee_high',
] as const
export type AutobidMiss = (typeof AUTOBID_MISSES)[number]

/** The rule's thresholds, Boris's to change in the pult («Настройки», group «Автоотклик, тень»). */
export type AutobidRule = { minSimilar: number; minSharePct: number; maxFeeRub: number | null }

export async function autobidRule(db: DbOrTx): Promise<AutobidRule> {
  return {
    minSimilar: await getSetting(db, 'autobid.min_similar'),
    minSharePct: await getSetting(db, 'autobid.min_share_pct'),
    maxFeeRub: await getSetting(db, 'autobid.max_fee_rub'),
  }
}

/** The bid's price as the card has it, and whether it was read from the order page just now. */
export type Fee = { rub: number; fromPage: boolean }

/**
 * Whether Sara would bid by herself: enough similar decisions, a share of bids above the threshold (strictly, as
 * Boris said «больше 80%»), and a fresh price no higher than the ceiling.
 */
export function wouldBid(
  similar: Pick<Share, 'n' | 'bid'> | null,
  fee: Fee,
  r: AutobidRule,
): { would: boolean; misses: AutobidMiss[] } {
  const n = similar?.n ?? 0
  const bid = similar?.bid ?? 0
  const misses: AutobidMiss[] = []
  if (n < r.minSimilar) misses.push('few_similar')
  // Integers, so 80% of 10 is not «more than 80%» by a rounding.
  if (n === 0 || bid * 100 <= r.minSharePct * n) misses.push('low_share')
  if (fee.rub <= 0) misses.push('fee_unknown')
  else if (!fee.fromPage) misses.push('fee_not_fresh')
  if (fee.rub > 0 && r.maxFeeRub !== null && fee.rub > r.maxFeeRub) misses.push('fee_high')
  return { would: misses.length === 0, misses }
}

/** What `lead.autobid_shadow` keeps: numbers and flags only, never the client's words (ADR-016). */
export type AutobidShadowPayload = {
  would: boolean
  misses: AutobidMiss[]
  /** Similar decisions and his bids among them. */
  n: number
  bid: number
  fee_rub: number | null
  fee_from_page: boolean
  min_similar: number
  min_share_pct: number
  max_fee_rub: number | null
}

export function shadowPayload(
  similar: Pick<Share, 'n' | 'bid'> | null,
  fee: Fee,
  r: AutobidRule,
): AutobidShadowPayload {
  const { would, misses } = wouldBid(similar, fee, r)
  return {
    would,
    misses,
    n: similar?.n ?? 0,
    bid: similar?.bid ?? 0,
    fee_rub: fee.rub > 0 ? fee.rub : null,
    fee_from_page: fee.fromPage,
    min_similar: r.minSimilar,
    min_share_pct: r.minSharePct,
    max_fee_rub: r.maxFeeRub,
  }
}
