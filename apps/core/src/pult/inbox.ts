import {
  type EntityRef,
  type InboxAction,
  type InboxItem,
  type InboxView,
  QUESTION_KINDS,
  TASK_KINDS,
  type TaskActionSpec,
} from '@sara/shared'
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import {
  bidHold,
  chatMessage,
  convTurn,
  lead,
  leadScore,
  question,
  ruleProposal,
  task,
} from '../db/schema'
import { LEAD_TASK_KINDS, waitEnd } from '../leads/waiting'
import { clientNames } from './feed'

/**
 * «Входящие» (FR-UI-6, pult v2 design 3): the open tasks and the open questions of the core as rows with the
 * presses each takes on the spot. Nothing is stored here; a kind this code does not know shows «Открыть» alone.
 */

/** A question Boris left unanswered this long is no longer waited for. */
const QUESTION_FRESH_MS = 48 * 3600 * 1000

const taskActions = (taskId: string, specs: TaskActionSpec[]): InboxAction[] =>
  specs.map((a) => ({
    id: a.action,
    label: a.label,
    look: a.look,
    needs: a.needs,
    path: `/api/tasks/${taskId}/${a.action}`,
  }))

const questionActions = (id: string, answer: string): InboxAction[] => [
  {
    id: 'answer',
    label: answer,
    look: 'primary',
    needs: 'text',
    path: `/api/questions/${id}/answer`,
  },
  { id: 'skip', label: 'Не важно', look: 'ghost', needs: null, path: `/api/questions/${id}/skip` },
]

const leadRef = (l: typeof lead.$inferSelect): EntityRef => ({
  kind: 'lead',
  id: l.id,
  title: l.title,
})
const leadLink = (id: string) => `/leads/${encodeURIComponent(id)}`
const clientLink = (id: string) => `/clients/${id}`

type TaskRow = typeof task.$inferSelect
type TurnRow = typeof convTurn.$inferSelect

export async function inboxView(db: DbOrTx, now = new Date()): Promise<InboxView> {
  const all = await db
    .select()
    .from(task)
    .where(eq(task.state, 'open'))
    .orderBy(asc(task.createdAt))
  const leadIds = all.filter((t) => t.entityKind === 'lead').map((t) => t.entityId)
  const leads = new Map(
    (leadIds.length ? await db.select().from(lead).where(inArray(lead.id, leadIds)) : []).map(
      (l) => [l.id, l],
    ),
  )
  // A lead's task is here only while the bot would still offer it (leads/waiting.ts): the sweep closes the rest.
  const tasks = all.filter((t) => {
    if (!(LEAD_TASK_KINDS as readonly string[]).includes(t.kind)) return true
    const l = leads.get(t.entityId)
    return l !== undefined && waitEnd(t, l, now) === null
  })
  const turnIds = tasks.filter((t) => t.entityKind === 'conv_turn').map((t) => t.entityId)
  const turns = new Map(
    (turnIds.length
      ? await db.select().from(convTurn).where(inArray(convTurn.id, turnIds))
      : []
    ).map((t) => [t.id, t]),
  )
  const proposalIds = tasks
    .filter((t) => t.kind === 'rule_proposal')
    .map((t) => t.entityId)
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const proposals = new Map(
    (proposalIds.length
      ? await db.select().from(ruleProposal).where(inArray(ruleProposal.id, proposalIds))
      : []
    ).map((p) => [p.id, p]),
  )
  const names = await clientNames(
    db,
    [...turns.values()].map((t) => t.conversationId),
  )
  // The client's words a draft answers, for the row's second line.
  const words = new Map<string, string>()
  for (const t of turns.values()) {
    const ids = (t.messageIds as string[] | null) ?? []
    if (ids.length === 0) continue
    const rows = await db
      .select({ id: chatMessage.platformMessageId, text: chatMessage.text })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.conversationId, t.conversationId),
          inArray(chatMessage.platformMessageId, ids),
        ),
      )
    const said = ids
      .map((id) => rows.find((r) => r.id === id)?.text ?? '')
      .filter(Boolean)
      .join(' ')
    if (said) words.set(t.id, said.slice(0, 200))
  }

  const decisionIds = tasks.filter((t) => t.kind === 'lead_decision').map((t) => t.id)
  const holds = new Map(
    (decisionIds.length
      ? await db
          .select({ taskId: bidHold.taskId, at: bidHold.executeAt })
          .from(bidHold)
          .where(and(inArray(bidHold.taskId, decisionIds), eq(bidHold.state, 'held')))
      : []
    ).map((h) => [h.taskId, new Date(h.at).toISOString()]),
  )
  const fits = new Map<string, number>()
  if (leadIds.length)
    for (const r of await db
      .select({ leadId: leadScore.leadId, score: leadScore.score })
      .from(leadScore)
      .where(and(inArray(leadScore.leadId, leadIds), eq(leadScore.backtest, false)))
      .orderBy(asc(leadScore.createdAt)))
      fits.set(r.leadId, r.score)

  const items: InboxItem[] = []
  const leadItem = (t: TaskRow, l: typeof lead.$inferSelect): InboxItem => {
    const spec = TASK_KINDS[t.kind]
    // A decision from the pult goes through the lead's own presses: the bid waits ten seconds (design 4).
    const actions = taskActions(t.id, spec?.actions ?? []).map((a) =>
      t.kind === 'lead_decision' && (a.id === 'bid' || a.id === 'skip')
        ? { ...a, path: `/api/leads/${encodeURIComponent(l.id)}/${a.id}` }
        : a,
    )
    const fit = fits.get(l.id)
    const held = holds.get(t.id)
    return {
      id: `task:${t.id}`,
      source: 'task',
      kind: t.kind,
      title: spec?.title ?? t.kind,
      sub: [
        l.city,
        fit !== undefined ? `наше ${fit}` : null,
        l.bidPriceRub > 0 ? `отклик ${l.bidPriceRub} ₽` : null,
        l.budgetText ? `бюджет ${l.budgetText}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      text: null,
      at: t.createdAt,
      urgent: false,
      entity: leadRef(l),
      link: leadLink(l.id),
      actions,
      feeRub: l.bidPriceRub > 0 ? l.bidPriceRub : null,
      hold: held ? { executeAt: held } : null,
    }
  }
  const turnItem = (t: TaskRow, turn: TurnRow): InboxItem => {
    const kind = t.kind === 'conv_draft' && turn.kind === 'reminder' ? 'conv_reminder' : t.kind
    const spec = TASK_KINDS[kind]
    const name = names.get(turn.conversationId) ?? 'Клиент'
    const said = words.get(turn.id)
    return {
      id: `task:${t.id}`,
      source: 'task',
      kind,
      title: spec?.title ?? kind,
      sub: said ? `${name}: «${said}»` : name,
      text: turn.text,
      at: t.createdAt,
      urgent: turn.urgent,
      entity: { kind: 'client', id: turn.conversationId, title: name },
      link: clientLink(turn.conversationId),
      actions: taskActions(t.id, spec?.actions ?? []),
      feeRub: null,
      hold: null,
    }
  }
  for (const t of tasks) {
    const l = t.entityKind === 'lead' ? leads.get(t.entityId) : undefined
    const turn = t.entityKind === 'conv_turn' ? turns.get(t.entityId) : undefined
    if (l) items.push(leadItem(t, l))
    else if (turn) items.push(turnItem(t, turn))
    else if (t.kind === 'rule_proposal') {
      const p = proposals.get(t.entityId)
      const b = (p?.backtest ?? {}) as {
        checked?: number
        changed?: number
        towardBoris?: number
        against?: number
      }
      items.push({
        id: `task:${t.id}`,
        source: 'task',
        kind: t.kind,
        title: TASK_KINDS.rule_proposal?.title ?? t.kind,
        sub: p
          ? `v${p.fromVersion} → v${p.fromVersion + 1}: ${p.summary}. ${p.why}${b.checked ? ` На последних ${b.checked} заявках изменило бы ${b.changed ?? 0}: ${b.towardBoris ?? 0} в твою сторону, ${b.against ?? 0} против.` : ''}`
          : null,
        text: null,
        at: t.createdAt,
        urgent: false,
        entity: p ? { kind: 'account', id: p.accountId, title: 'Правила отбора' } : null,
        link: p ? `/settings/rules/${encodeURIComponent(p.accountId)}` : '/settings',
        actions: taskActions(t.id, TASK_KINDS.rule_proposal?.actions ?? []),
        feeRub: null,
        hold: null,
      })
    } else
      items.push({
        id: `task:${t.id}`,
        source: 'task',
        kind: t.kind,
        title: TASK_KINDS[t.kind]?.title ?? `Задача: ${t.kind}`,
        sub: null,
        text: null,
        at: t.createdAt,
        urgent: false,
        entity: null,
        link: null,
        actions: [],
        feeRub: null,
        hold: null,
      })
  }

  const fresh = new Date(now.getTime() - QUESTION_FRESH_MS).toISOString()
  const questions = await db
    .select()
    .from(question)
    .where(and(isNull(question.answeredAt), gt(question.askedAt, fresh)))
    .orderBy(asc(question.askedAt))
  for (const q of questions) {
    const spec = QUESTION_KINDS[q.kind] ?? { title: 'Сара спрашивает', answer: 'Ответить' }
    let entity: EntityRef | null = null
    let link: string | null = null
    if (q.kind === 'why_skip' || q.kind === 'why_want') {
      const [l] = await db.select().from(lead).where(eq(lead.id, q.entityId))
      if (l) {
        entity = leadRef(l)
        link = leadLink(l.id)
      }
    } else if (q.kind === 'edit_draft' || q.kind === 'edit_price') {
      const [row] = /^[0-9a-f-]{36}$/i.test(q.entityId)
        ? await db
            .select({ l: lead })
            .from(task)
            .innerJoin(lead, eq(lead.id, task.entityId))
            .where(eq(task.id, q.entityId))
        : []
      if (row) {
        entity = leadRef(row.l)
        link = leadLink(row.l.id)
      }
    } else if (q.kind === 'conv_edit') {
      const [turn] = await db.select().from(convTurn).where(eq(convTurn.id, q.entityId))
      if (turn) {
        const name =
          (await clientNames(db, [turn.conversationId])).get(turn.conversationId) ?? 'Клиент'
        entity = { kind: 'client', id: turn.conversationId, title: name }
        link = clientLink(turn.conversationId)
      }
    }
    items.push({
      id: `question:${q.id}`,
      source: 'question',
      kind: q.kind,
      title: spec.title,
      sub: entity ? `«${entity.title}»` : null,
      text: null,
      at: q.askedAt,
      urgent: false,
      entity,
      link,
      actions: questionActions(q.id, spec.answer),
      feeRub: null,
      hold: null,
    })
  }

  // The urgent first, then the oldest: what waited longest is on top (design 3).
  items.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.at.localeCompare(b.at))
  return {
    items,
    counts: {
      leads: items.filter((i) => i.kind.startsWith('lead_') || i.kind === 'rule_proposal').length,
      drafts: items.filter((i) => i.kind.startsWith('conv_')).length,
      questions: items.filter((i) => i.source === 'question').length,
      other: items.filter(
        (i) =>
          i.source === 'task' &&
          !i.kind.startsWith('lead_') &&
          !i.kind.startsWith('conv_') &&
          i.kind !== 'rule_proposal',
      ).length,
    },
  }
}
