import {
  DirectionRules,
  formatCallback,
  newEventId,
  ProfiOrder,
  RulesProposalOutput,
} from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { jobRun, ruleProposal, task } from '../db/schema'
import { activeRules, addVersion } from '../direction/store'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import { rulesText } from '../leads/scorer'
import { sorterInput } from '../leads/sorter'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { backtest } from './backtest'
import { askWhy } from './questions'

/** A proposal needs this many answered surprises since the last one. */
export const SURPRISES_FOR_PROPOSAL = 3
const CASES_MAX = 20

const mskDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d)

const journal = (
  type: 'rules.proposed' | 'rules.applied' | 'rules.declined' | 'rules.proposal_invalid',
  accountId: string,
  id: string,
  actor: 'sara' | 'boris',
  payload: Record<string, unknown>,
  reason: string | null = null,
) => ({
  type,
  v: 1,
  entity: { kind: 'rule_proposal', id },
  account_id: accountId,
  actor,
  occurred_at: new Date().toISOString(),
  causation_id: null,
  correlation_id: newEventId(),
  reason,
  payload,
})

type Case = {
  title: string
  category: string
  city: string
  text: string
  budget_text: string | null
  bid_price_rub: number
  seen_at: string
  score: number | null
  label: string
  answer: string
}

/** Surprises Boris explained since the last proposal (or ever), newest first. */
async function explainedSurprises(db: Db, accountId: string, limit: number): Promise<Case[]> {
  const r = await db.execute<Case>(sql`
    select l.title, l.category, l.city, l.text, l.budget_text, l.bid_price_rub,
      to_char(l.seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as seen_at,
      b.score, b.label, q.answer
    from core.question q
    join core.lead_label b on b.lead_id = q.entity_id
    join core.lead l on l.id = b.lead_id
    where q.kind in ('why_skip', 'why_want') and q.answered_at is not null and l.account_id = ${accountId}
      and q.answered_at > coalesce(
        (select max(created_at) from core.rule_proposal where account_id = ${accountId}),
        '-infinity'::timestamptz)
    order by q.answered_at desc
    limit ${limit}`)
  return r.rows
}

const caseText = (c: Case, i: number) => {
  const order = ProfiOrder.parse({
    order_id: String(i + 1),
    title: c.title,
    category: c.category,
    city: c.city,
    text: c.text,
    // The client's name never goes to the model (ADR-016).
    client_name: '',
    budget_text: c.budget_text,
    bid_price_rub: c.bid_price_rub,
    seen_at: c.seen_at,
  })
  const decision = c.label === 'yes' ? 'взял бы (Сара отсеяла)' : 'пропустил'
  return `Случай ${i + 1}\n${sorterInput(order)}\nБалл Сары: ${c.score ?? 'нет'}\nБорис: ${decision}\nЕго причина: ${c.answer}`
}

/**
 * Proposes one change of the rules when Boris has explained at least 3 surprises since the last proposal, none
 * waits for his answer, and today had no proposal yet (FR-MIND-3). Rules that break the schema are thrown away.
 */
export async function maybePropose(
  d: { db: Db; gateway: Gateway; notifier: Pick<Notifier, 'sendButtons'> },
  accountId: string,
  now: Date,
): Promise<'asked' | 'not_yet' | 'invalid'> {
  const [waiting] = await d.db
    .select({ id: ruleProposal.id })
    .from(ruleProposal)
    .where(and(eq(ruleProposal.accountId, accountId), eq(ruleProposal.state, 'asked')))
  if (waiting) return 'not_yet'
  const cases = await explainedSurprises(d.db, accountId, CASES_MAX)
  if (cases.length < SURPRISES_FOR_PROPOSAL) return 'not_yet'
  // One model call a day at most, whatever comes of it.
  const taken = await d.db
    .insert(jobRun)
    .values({ name: `proposal:${accountId}`, day: mskDay(now) })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  if (taken.length === 0) return 'not_yet'

  const active = await activeRules(d.db, accountId)
  const input = [
    `Действующие правила v${active.version}`,
    rulesText(active.rules),
    '',
    'Те же правила в JSON:',
    JSON.stringify(active.rules),
    '',
    'Случаи, где решение Бориса разошлось с оценкой Сары:',
    ...cases.map(caseText),
  ].join('\n')
  const r = await d.gateway.call('rules-proposer', input, RulesProposalOutput)
  if (!r.ok) return 'not_yet'
  const id = newEventId()
  const rules = DirectionRules.safeParse(r.output.rules)
  if (!rules.success) {
    await appendEvent(
      d.db,
      journal(
        'rules.proposal_invalid',
        accountId,
        id,
        'sara',
        {},
        rules.error.message.slice(0, 300),
      ),
    )
    return 'invalid'
  }
  const bt = await backtest(d, accountId, rules.data, active.version + 1)
  const taskId = newEventId()
  await d.db.transaction(async (tx) => {
    await tx.insert(ruleProposal).values({
      id,
      accountId,
      fromVersion: active.version,
      rules: rules.data,
      summary: r.output.summary,
      why: r.output.why,
      backtest: bt,
      state: 'asked',
      taskId,
    })
    await tx
      .insert(task)
      .values({ id: taskId, kind: 'rule_proposal', entityKind: 'rule_proposal', entityId: id })
    await appendEvent(
      tx,
      journal('rules.proposed', accountId, id, 'sara', { from: active.version, ...bt }),
    )
  })
  await d.notifier.sendButtons(TEXTS.proposal(active.version, r.output.summary, r.output.why, bt), [
    [
      { text: TEXTS.applyButton, callbackData: formatCallback(taskId, 'apply') },
      { text: TEXTS.dropButton, callbackData: formatCallback(taskId, 'drop') },
    ],
  ])
  return 'asked'
}

/** «Применить» makes the proposed rules the new version; «Не надо» keeps them and asks why. */
export async function onProposalPress(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'> },
  taskId: string,
  action: 'apply' | 'drop',
): Promise<string> {
  const resolved = await d.db
    .update(task)
    .set({ state: 'resolved', resolution: action, resolvedAt: new Date().toISOString() })
    .where(and(eq(task.id, taskId), eq(task.kind, 'rule_proposal'), eq(task.state, 'open')))
    .returning({ proposalId: task.entityId })
  const proposalId = resolved[0]?.proposalId
  if (!proposalId) return TEXTS.alreadyDone
  const [p] = await d.db.select().from(ruleProposal).where(eq(ruleProposal.id, proposalId))
  if (!p) return TEXTS.alreadyDone
  const decided = (state: 'applied' | 'declined') =>
    d.db
      .update(ruleProposal)
      .set({ state, decidedAt: new Date().toISOString() })
      .where(eq(ruleProposal.id, p.id))
  if (action === 'drop') {
    await decided('declined')
    await appendEvent(d.db, journal('rules.declined', p.accountId, p.id, 'boris', {}))
    await askWhy(d, { kind: 'why_decline', entityId: p.id, title: p.summary }, new Date())
    return TEXTS.kept(p.fromVersion)
  }
  // Made for older rules (a rollback or another change came in between): it is not applied blindly.
  if ((await activeRules(d.db, p.accountId)).version !== p.fromVersion) {
    await decided('declined')
    return TEXTS.proposalStale
  }
  const version = await addVersion(d.db, {
    accountId: p.accountId,
    rules: DirectionRules.parse(p.rules),
    createdBy: 'boris',
    reason: p.summary,
  })
  await decided('applied')
  await appendEvent(d.db, journal('rules.applied', p.accountId, p.id, 'boris', { version }))
  return TEXTS.applied(version)
}
