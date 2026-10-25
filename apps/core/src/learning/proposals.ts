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
import { rulesDiff } from '../direction/diff'
import { activeRules, insertVersion } from '../direction/store'
import type { Gateway } from '../gateway/gateway'
import { hasTag } from '../gateway/redact'
import { appendEvent } from '../journal/journal'
import { namesToHide } from '../leads/clientName'
import { rulesText } from '../leads/scorer'
import { sorterInput } from '../leads/sorter'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { backtest } from './backtest'
import { askWhy } from './questions'

/** A proposal needs this many answered surprises since the last one. */
export const SURPRISES_FOR_PROPOSAL = 3
const CASES_MAX = 20
/** The proposer sees this many of Boris's latest refusals, so it does not bring them back. */
const DECLINED_MAX = 5

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
  client_name: string
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
    select l.title, l.category, l.city, l.text, l.client_name, l.budget_text, l.bid_price_rub,
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
    // The client's name is not put in the case; one inside its text is hidden by the gateway (ADR-016).
    client_name: '',
    budget_text: c.budget_text,
    bid_price_rub: c.bid_price_rub,
    seen_at: c.seen_at,
  })
  const decision = c.label === 'yes' ? 'взял бы (Сара отсеяла)' : 'пропустил'
  return `Случай ${i + 1}\n${sorterInput(order)}\nБалл Сары: ${c.score ?? 'нет'}\nБорис: ${decision}\nЕго причина: ${c.answer}`
}

type Declined = { summary: string; answer: string | null }

/** Proposals Boris turned down with «Не надо» (a stale «Применить» is not his refusal), newest first. */
async function declinedProposals(db: Db, accountId: string, limit: number): Promise<Declined[]> {
  const r = await db.execute<Declined>(sql`
    select p.summary, q.answer
    from core.rule_proposal p
    join core.task t on t.id = p.task_id and t.resolution = 'drop'
    left join lateral (
      select q.answer from core.question q
      where q.kind = 'why_decline' and q.entity_id = p.id::text and q.answered_at is not null
      order by q.answered_at desc
      limit 1
    ) q on true
    where p.account_id = ${accountId} and p.state = 'declined'
    order by p.decided_at desc
    limit ${limit}`)
  return r.rows
}

const declinedText = (p: Declined) =>
  `- ${p.summary.replace(/[.\s]+$/, '')}. Его причина: ${p.answer ?? 'не назвал'}`

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
  const declined = await declinedProposals(d.db, accountId, DECLINED_MAX)
  const input = [
    `Действующие правила v${active.version}`,
    rulesText(active.rules),
    '',
    'Те же правила в JSON:',
    JSON.stringify(active.rules),
    '',
    ...(declined.length > 0
      ? ['Поправки, от которых Борис уже отказался:', ...declined.map(declinedText), '']
      : []),
    'Случаи, где решение Бориса разошлось с оценкой Сары:',
    ...cases.map(caseText),
  ].join('\n')
  // The proposal is kept and read by the Scorer for every later order: nothing of a client may come back into it.
  const r = await d.gateway.call('rules-proposer', input, RulesProposalOutput, {
    redact: { names: namesToHide(...cases.map((c) => c.client_name)), restore: false },
  })
  const id = newEventId()
  if (!r.ok) {
    // An answer off the schema is a broken proposal like any other; a model that did not answer is not.
    if (r.errorClass !== 'bad_output') return 'not_yet'
    await appendEvent(
      d.db,
      journal('rules.proposal_invalid', accountId, id, 'sara', {}, r.message.slice(0, 300)),
    )
    return 'invalid'
  }
  if (hasTag(JSON.stringify(r.output))) {
    await appendEvent(
      d.db,
      journal(
        'rules.proposal_invalid',
        accountId,
        id,
        'sara',
        {},
        'the proposal holds a client tag',
      ),
    )
    return 'invalid'
  }
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
  // One change at a time, and Boris sees it as computed from the rules, not only as the model tells it.
  const diff = rulesDiff(active.rules, rules.data)
  if (diff.sections.length !== 1) {
    await appendEvent(
      d.db,
      journal(
        'rules.proposal_invalid',
        accountId,
        id,
        'sara',
        { sections: diff.sections },
        'not one change',
      ),
    )
    return 'invalid'
  }
  const bt = await backtest(d, accountId, active.rules, rules.data, active.version + 1)
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
      // The caller's clock, like the day's place above: the next proposal counts surprises explained after this.
      createdAt: now.toISOString(),
    })
    await tx
      .insert(task)
      .values({ id: taskId, kind: 'rule_proposal', entityKind: 'rule_proposal', entityId: id })
    await appendEvent(
      tx,
      journal('rules.proposed', accountId, id, 'sara', { from: active.version, ...bt }),
    )
  })
  try {
    await d.notifier.sendButtons(
      TEXTS.proposal(active.version, r.output.summary, r.output.why, diff.lines, bt),
      [
        [
          { text: TEXTS.applyButton, callbackData: formatCallback(taskId, 'apply') },
          { text: TEXTS.dropButton, callbackData: formatCallback(taskId, 'drop') },
        ],
      ],
    )
  } catch (e) {
    // Boris never saw it: nothing may wait for his answer, or no proposal would ever come again.
    await d.db.transaction(async (tx) => {
      await tx.delete(task).where(eq(task.id, taskId))
      await tx.delete(ruleProposal).where(eq(ruleProposal.id, id))
    })
    throw e
  }
  return 'asked'
}

/** «Применить» makes the proposed rules the new version; «Не надо» keeps them and asks why. */
export async function onProposalPress(
  d: { db: Db; notifier: Pick<Notifier, 'sendText'>; now?: () => Date },
  taskId: string,
  action: 'apply' | 'drop',
): Promise<string> {
  const now = d.now?.() ?? new Date()
  // All or nothing: the press, the new version and the proposal's state commit together, so a failed write
  // leaves the buttons working.
  const done = await d.db.transaction(async (tx) => {
    const resolved = await tx
      .update(task)
      .set({ state: 'resolved', resolution: action, resolvedAt: now.toISOString() })
      .where(and(eq(task.id, taskId), eq(task.kind, 'rule_proposal'), eq(task.state, 'open')))
      .returning({ proposalId: task.entityId })
    const proposalId = resolved[0]?.proposalId
    if (!proposalId) return null
    const [p] = await tx.select().from(ruleProposal).where(eq(ruleProposal.id, proposalId))
    if (!p) return null
    const decided = (state: 'applied' | 'declined') =>
      tx
        .update(ruleProposal)
        .set({ state, decidedAt: now.toISOString() })
        .where(eq(ruleProposal.id, p.id))
    if (action === 'drop') {
      await decided('declined')
      await appendEvent(tx, journal('rules.declined', p.accountId, p.id, 'boris', {}))
      return { p, reply: TEXTS.kept(p.fromVersion), ask: true }
    }
    // Made for older rules (a rollback or another change came in between): it is not applied blindly.
    if ((await activeRules(tx, p.accountId)).version !== p.fromVersion) {
      await decided('declined')
      return { p, reply: TEXTS.proposalStale, ask: false }
    }
    const version = await insertVersion(tx, {
      accountId: p.accountId,
      rules: DirectionRules.parse(p.rules),
      createdBy: 'boris',
      reason: p.summary,
    })
    await decided('applied')
    await appendEvent(tx, journal('rules.applied', p.accountId, p.id, 'boris', { version }))
    return { p, reply: TEXTS.applied(version), ask: false }
  })
  if (!done) return TEXTS.alreadyDone
  if (done.ask)
    await askWhy(d, { kind: 'why_decline', entityId: done.p.id, title: done.p.summary }, now)
  return done.reply
}
