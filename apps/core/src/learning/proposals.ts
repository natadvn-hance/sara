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
import { isReasonCode, type Reason, reasonText } from './reasons'

/** A proposal needs this many answered surprises since the last one. */
export const SURPRISES_FOR_PROPOSAL = 3
/** Or this many closes with one reason (07.11.2026), in REASON_WINDOW_DAYS, since the last answered proposal on it. */
export const REASONS_FOR_PROPOSAL = 5
const REASON_WINDOW_DAYS = 14
/** A proposal without an answer this long no longer holds back the next one. */
export const PROPOSAL_WAIT_MS = 3 * 24 * 3600_000
const CASES_MAX = 20
/** How many of the repeated reason's orders, and of Boris's latest bids, the proposer sees. */
const REASON_CASES_MAX = 12
const BIDS_MAX = 5
/** The proposer sees this many of Boris's latest refusals, so it does not bring them back. */
const DECLINED_MAX = 5

const mskDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d)

const journal = (
  type:
    | 'rules.proposed'
    | 'rules.applied'
    | 'rules.declined'
    | 'rules.proposal_invalid'
    | 'rules.expired',
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

/**
 * Surprises Boris explained since the last proposal they brought (or ever), newest first. A proposal that went stale
 * (made for older rules) does not count: its surprises are still unanswered by any rule.
 */
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
        (select max(created_at) from core.rule_proposal
          where account_id = ${accountId} and reason_code is null and state <> 'stale'),
        '-infinity'::timestamptz)
    order by q.answered_at desc
    limit ${limit}`)
  return r.rows
}

const orderText = (c: Omit<Case, 'score' | 'label' | 'answer'>, i: number) =>
  sorterInput(
    ProfiOrder.parse({
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
    }),
  )

const caseText = (c: Case, i: number) => {
  const decision = c.label === 'yes' ? 'взял бы (Сара отсеяла)' : 'пропустил'
  return `Случай ${i + 1}\n${orderText(c, i)}\nБалл Сары: ${c.score ?? 'нет'}\nБорис: ${decision}\nЕго причина: ${c.answer}`
}

/** One reason Boris kept closing cards with: the code, and for «не наш профиль» its detail too. */
type Repeated = { code: string; detail: string; n: number; chosen: number }

/**
 * The reason behind the most closes (the bot and the pult, Sara's guess he left or his own pick) in the last 14 days,
 * at least REASONS_FOR_PROPOSAL of them, counted since the last proposal on it Boris answered; null: none repeats.
 * «Другое» says nothing to make a rule of. «Не наш профиль» counts by its detail: SMM is not a marketplace.
 */
async function repeatedReason(db: Db, accountId: string, now: Date): Promise<Repeated | null> {
  const since = new Date(now.getTime() - REASON_WINDOW_DAYS * 86_400_000).toISOString()
  const r = await db.execute<{ code: string; detail: string; n: string; chosen: string }>(sql`
    with closes as (
      select b.reason_code as code,
        case when b.reason_code = 'profile' then coalesce(b.reason_detail, '') else '' end as detail,
        b.reason_by, b.at
      from core.lead_label b
      join core.lead l on l.id = b.lead_id
      where l.account_id = ${accountId} and b.label = 'no' and b.source in ('card', 'pult')
        and b.reason_code is not null and b.reason_code <> 'other' and b.at > ${since}::timestamptz
    )
    select c.code, c.detail, count(*) as n, count(*) filter (where c.reason_by = 'boris') as chosen
    from closes c
    where c.at > coalesce(
      (select max(p.created_at) from core.rule_proposal p
        where p.account_id = ${accountId} and p.reason_code = c.code
          and coalesce(p.reason_detail, '') = c.detail and p.state in ('applied', 'declined', 'expired')),
      '-infinity'::timestamptz)
    group by c.code, c.detail
    having count(*) >= ${REASONS_FOR_PROPOSAL}
    order by count(*) desc, count(*) filter (where c.reason_by = 'boris') desc, c.code
    limit 1`)
  const row = r.rows[0]
  return row
    ? { code: row.code, detail: row.detail, n: Number(row.n), chosen: Number(row.chosen) }
    : null
}

type ReasonCase = Omit<Case, 'label' | 'answer'> & { reason_by: string | null }

/** The repeated reason as the proposer reads it: its numbers, the closed orders, the orders Boris bid on. */
async function reasonInput(db: Db, accountId: string, rep: Repeated, now: Date) {
  const since = new Date(now.getTime() - REASON_WINDOW_DAYS * 86_400_000).toISOString()
  const same = sql`b.reason_code = ${rep.code}
    and (${rep.code} <> 'profile' or coalesce(b.reason_detail, '') = ${rep.detail})`
  const closed = await db.execute<ReasonCase>(sql`
    select l.title, l.category, l.city, l.text, l.client_name, l.budget_text, l.bid_price_rub,
      to_char(l.seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as seen_at,
      b.score, b.reason_by
    from core.lead_label b
    join core.lead l on l.id = b.lead_id
    where l.account_id = ${accountId} and b.label = 'no' and b.source in ('card', 'pult')
      and b.at > ${since}::timestamptz and ${same}
    order by b.at desc
    limit ${REASON_CASES_MAX}`)
  const [ignored] = (
    await db.execute<{ n: string }>(sql`
      select count(*) as n from core.lead_label b
      join core.lead l on l.id = b.lead_id
      where l.account_id = ${accountId} and b.label = 'weak_no' and b.at > ${since}::timestamptz and ${same}`)
  ).rows
  const bids = await db.execute<{ title: string; category: string; client_name: string }>(sql`
    select l.title, l.category, l.client_name
    from core.lead_label b
    join core.lead l on l.id = b.lead_id
    where l.account_id = ${accountId} and b.label = 'yes'
    order by b.at desc
    limit ${BIDS_MAX}`)
  const reason: Reason = {
    code: isReasonCode(rep.code) ? rep.code : 'other',
    detail: rep.detail || null,
  }
  const said = reasonText(reason)
  const weak = Number(ignored?.n ?? 0)
  const lines = [
    `Повторяющаяся причина: «${said}».`,
    `За ${REASON_WINDOW_DAYS} дней Борис закрыл ${rep.n} таких карточек: причину выбрал сам в ${rep.chosen}, в остальных не поправил догадку Сары.${weak > 0 ? ` Ещё ${weak} таких карточек он не открыл.` : ''}`,
    '',
    'Закрытые заказы с этой причиной:',
    ...closed.rows.map(
      (c, i) =>
        `Случай ${i + 1}\n${orderText(c, i)}\nБалл Сары: ${c.score ?? 'нет'}\nБорис: закрыл\nПричина: ${said} (${c.reason_by === 'boris' ? 'выбрал сам' : 'угадала Сара, он не поправил'})`,
    ),
    ...(bids.rows.length > 0
      ? [
          '',
          'Заказы, на которые Борис откликнулся (поправка не должна их отсеять):',
          ...bids.rows.map((b) => `- «${b.title.trim()}» (${b.category.trim()})`),
        ]
      : []),
  ]
  return {
    text: lines.join('\n'),
    said,
    names: [...closed.rows.map((c) => c.client_name), ...bids.rows.map((b) => b.client_name)],
  }
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
 * A proposal no longer waits when it was made for older rules (`stale`: a rollback or another change came in
 * between) or had no answer for three days (`expired`): it holds back no new one (07.11.2026, the v6 → v7 of 03.11
 * held them all). Its buttons give way to «Устарело» when its message is known.
 */
export async function expireProposals(
  d: { db: Db; notifier?: Pick<Notifier, 'markDone'> },
  accountId: string,
  now: Date,
): Promise<number> {
  const waiting = await d.db
    .select()
    .from(ruleProposal)
    .where(and(eq(ruleProposal.accountId, accountId), eq(ruleProposal.state, 'asked')))
  if (waiting.length === 0) return 0
  const active = (await activeRules(d.db, accountId)).version
  let n = 0
  for (const p of waiting) {
    const state =
      p.fromVersion !== active
        ? 'stale'
        : now.getTime() - new Date(p.createdAt).getTime() > PROPOSAL_WAIT_MS
          ? 'expired'
          : null
    if (!state) continue
    const messageId = await d.db.transaction(async (tx) => {
      const rows = await tx
        .update(ruleProposal)
        .set({ state, decidedAt: now.toISOString() })
        .where(and(eq(ruleProposal.id, p.id), eq(ruleProposal.state, 'asked')))
        .returning({ id: ruleProposal.id })
      if (rows.length === 0) return undefined
      const [t] = p.taskId
        ? await tx
            .update(task)
            .set({ state: 'resolved', resolution: state, resolvedAt: now.toISOString() })
            .where(and(eq(task.id, p.taskId), eq(task.state, 'open')))
            .returning({ messageId: task.telegramMessageId })
        : []
      await appendEvent(
        tx,
        journal('rules.expired', accountId, p.id, 'sara', {
          why: state === 'stale' ? 'stale' : 'unanswered',
          from: p.fromVersion,
          active,
        }),
      )
      return t?.messageId ?? null
    })
    if (messageId === undefined) continue
    n++
    if (messageId == null) continue
    try {
      await d.notifier?.markDone?.(messageId, TEXTS.proposalExpired)
    } catch (e) {
      console.error('proposal not marked', e instanceof Error ? e.message.slice(0, 200) : e)
    }
  }
  return n
}

/**
 * Proposes one change of the rules (FR-MIND-3) when Boris has explained at least 3 surprises since the last
 * proposal, or closed at least 5 cards with one reason (07.11.2026); none waits for his answer, and today had no
 * proposal yet. A stale or forgotten proposal is closed first, so it never holds the next one back. Rules that break
 * the schema are thrown away.
 */
export async function maybePropose(
  d: { db: Db; gateway: Gateway; notifier: Pick<Notifier, 'sendButtons' | 'markDone'> },
  accountId: string,
  now: Date,
): Promise<'asked' | 'not_yet' | 'invalid'> {
  await expireProposals(d, accountId, now)
  const [waiting] = await d.db
    .select({ id: ruleProposal.id })
    .from(ruleProposal)
    .where(and(eq(ruleProposal.accountId, accountId), eq(ruleProposal.state, 'asked')))
  if (waiting) return 'not_yet'
  const cases = await explainedSurprises(d.db, accountId, CASES_MAX)
  // Boris's own words come first; a repeated reason is the way when he gave none.
  const repeated =
    cases.length >= SURPRISES_FOR_PROPOSAL ? null : await repeatedReason(d.db, accountId, now)
  if (cases.length < SURPRISES_FOR_PROPOSAL && !repeated) return 'not_yet'
  // One model call a day at most, whatever comes of it.
  const taken = await d.db
    .insert(jobRun)
    .values({ name: `proposal:${accountId}`, day: mskDay(now) })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  if (taken.length === 0) return 'not_yet'

  const active = await activeRules(d.db, accountId)
  const declined = await declinedProposals(d.db, accountId, DECLINED_MAX)
  const why = repeated ? await reasonInput(d.db, accountId, repeated, now) : null
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
    ...(why
      ? [why.text]
      : ['Случаи, где решение Бориса разошлось с оценкой Сары:', ...cases.map(caseText)]),
  ].join('\n')
  // The proposal is kept and read by the Scorer for every later order: nothing of a client may come back into it.
  const r = await d.gateway.call('rules-proposer', input, RulesProposalOutput, {
    redact: {
      names: namesToHide(...(why ? why.names : cases.map((c) => c.client_name))),
      restore: false,
    },
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
      reasonCode: repeated?.code ?? null,
      reasonDetail: repeated ? repeated.detail || null : null,
      // The caller's clock, like the day's place above: the next proposal counts surprises explained after this.
      createdAt: now.toISOString(),
    })
    await tx
      .insert(task)
      .values({ id: taskId, kind: 'rule_proposal', entityKind: 'rule_proposal', entityId: id })
    await appendEvent(
      tx,
      journal('rules.proposed', accountId, id, 'sara', {
        from: active.version,
        ...bt,
        ...(repeated && { reason_code: repeated.code, closes: repeated.n }),
      }),
    )
  })
  let sent: { messageId: number }
  try {
    sent = await d.notifier.sendButtons(
      TEXTS.proposal(
        active.version,
        r.output.summary,
        r.output.why,
        diff.lines,
        bt,
        repeated && why ? TEXTS.proposalBasis(repeated.n, why.said, repeated.chosen) : null,
      ),
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
  // Kept so an expired proposal can lose its buttons.
  await d.db
    .update(task)
    .set({ telegramMessageId: sent.messageId })
    .where(eq(task.id, taskId))
    .catch((e: unknown) =>
      console.error('proposal message not kept', e instanceof Error ? e.message.slice(0, 200) : e),
    )
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
    const decided = (state: 'applied' | 'declined' | 'stale') =>
      tx
        .update(ruleProposal)
        .set({ state, decidedAt: now.toISOString() })
        .where(eq(ruleProposal.id, p.id))
    if (action === 'drop') {
      await decided('declined')
      await appendEvent(tx, journal('rules.declined', p.accountId, p.id, 'boris', {}))
      return { p, reply: TEXTS.kept(p.fromVersion), ask: true }
    }
    // Made for older rules (a rollback or another change came in between): it is not applied blindly, and it is
    // no refusal either; the next tick may bring a new one on the same grounds.
    const active = (await activeRules(tx, p.accountId)).version
    if (active !== p.fromVersion) {
      await decided('stale')
      await appendEvent(
        tx,
        journal('rules.expired', p.accountId, p.id, 'boris', {
          why: 'stale',
          from: p.fromVersion,
          active,
        }),
      )
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
  if (!done) {
    // A press on a proposal Sara closed as old: say so, not «уже сделано».
    const [t] = await d.db
      .select({ resolution: task.resolution })
      .from(task)
      .where(eq(task.id, taskId))
    return t?.resolution === 'stale' || t?.resolution === 'expired'
      ? TEXTS.proposalStale
      : TEXTS.alreadyDone
  }
  if (done.ask)
    await askWhy(d, { kind: 'why_decline', entityId: done.p.id, title: done.p.summary }, now)
  return done.reply
}
