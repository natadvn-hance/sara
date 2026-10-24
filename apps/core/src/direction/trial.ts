import { type DirectionRules, ProfiOrder, type ScorerOutput } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { lead, trialScore as trialTable } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { loadRole } from '../gateway/roles'
import { scoreOrder } from '../leads/scorer'
import { rulesHash } from './hash'

export type TrialMode = 'plain' | 'escalated'

/** The Claude limit is not a miss: a run that meets it stops and says so, instead of skipping leads one by one. */
export class ClaudeLimitError extends Error {
  constructor() {
    super('the Claude limit holds')
  }
}

export type TrialResult = {
  score: number
  decision: 'show' | 'drop'
  stopFactor: string | null
  redFlags: string[]
  axes: ScorerOutput['axes']
  reason: string
  confidence: number
  model: 'haiku' | 'sonnet'
}

export type TrialDeps = { db: Db; gateway: Gateway; rolesDir: string }

/** A stored lead as the Scorer reads it; the client's name is never part of it. */
export const orderOfLead = (l: typeof lead.$inferSelect): ProfiOrder =>
  ProfiOrder.parse({
    order_id: l.id,
    title: l.title,
    category: l.category,
    city: l.city,
    text: l.text,
    client_name: '',
    budget_text: l.budgetText,
    bid_price_rub: l.bidPriceRub,
    seen_at: new Date(l.seenAt).toISOString(),
  })

/**
 * The lead scored under `rules` to try them out (FR-ACC-5): from the cache when the same rules and the same
 * scorer prompt already scored it, else by the model at P3 and kept. A model miss is null and is not kept; the
 * Claude limit throws ClaudeLimitError.
 * `plain` is haiku alone, so two sets of rules are compared on one model; `escalated` is as in work.
 */
export async function trialScore(
  d: TrialDeps,
  leadId: string,
  rules: DirectionRules,
  mode: TrialMode,
): Promise<TrialResult | null> {
  const [row] = await d.db.select().from(lead).where(eq(lead.id, leadId))
  if (!row) return null
  const hash = rulesHash(rules)
  const roleVersion = (await loadRole(d.rolesDir, 'scorer')).meta.version
  const key = and(
    eq(trialTable.rulesHash, hash),
    eq(trialTable.leadId, leadId),
    eq(trialTable.mode, mode),
    eq(trialTable.roleVersion, roleVersion),
  )
  const [cached] = await d.db.select().from(trialTable).where(key)
  if (cached) {
    return {
      score: cached.score,
      decision: cached.decision === 'show' ? 'show' : 'drop',
      stopFactor: cached.stopFactor,
      redFlags: cached.redFlags as string[],
      axes: cached.axes as ScorerOutput['axes'],
      reason: cached.reason,
      confidence: cached.confidence,
      model: cached.model === 'sonnet' ? 'sonnet' : 'haiku',
    }
  }
  let limited = false
  const s = await scoreOrder(d.gateway, orderOfLead(row), rules, {
    escalate: mode === 'escalated',
    priority: 'P3',
    onFailure: (errorClass) => {
      if (errorClass === 'limit_reached') limited = true
    },
  })
  if (limited) throw new ClaudeLimitError()
  if (!s) return null
  const result: TrialResult = {
    score: s.score,
    decision: s.decision,
    stopFactor: s.stopFactor,
    redFlags: s.redFlags,
    axes: s.axes,
    reason: s.reason,
    confidence: s.confidence,
    model: s.model,
  }
  await d.db
    .insert(trialTable)
    .values({ rulesHash: hash, leadId, mode, roleVersion, ...result })
    .onConflictDoNothing()
  return result
}
