import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { account, lead, task } from '../../src/db/schema'
import { seedDirection } from '../../src/direction/store'
import { appendEvent } from '../../src/journal/journal'
import { waitEnd, waitingCounts } from '../../src/leads/waiting'
import { dailySummary } from '../../src/learning/summary'
import type { Notifier } from '../../src/notify/notifier'
import { inboxView } from '../../src/pult/inbox'
import { leadQueue, openLeadCount } from '../../src/pult/leads'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const NOW = new Date('2026-10-30T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()

beforeEach(async () => {
  await resetDb(db)
  await db
    .insert(account)
    .values({ id: 'hance-marketing', title: 'Hance маркетинг', egressIp: '127.0.0.1' })
})

let n = 0
/** An order seen `seenH` hours ago with one task of `kind` made `taskH` hours ago. */
async function waiting(
  kind: 'lead_decision' | 'lead_held' | 'lead_review',
  seenH: number,
  taskH = seenH,
  status = kind === 'lead_held' ? 'held' : kind === 'lead_review' ? 'scored_out' : 'queued',
) {
  const id = String(96000000 + n++)
  await db.insert(lead).values({
    id,
    accountId: 'hance-marketing',
    title: `Заказ ${id}`,
    category: 'Маркетинг',
    city: 'Краснодар',
    text: 'Нужна стратегия.',
    clientName: 'Ирина',
    bidPriceRub: 150,
    seenAt: hoursAgo(seenH),
    status,
    correlationId: newEventId(),
    draftText: 'Добрый день! ...',
    draftPriceRub: 30000,
  })
  const taskId = newEventId()
  await db
    .insert(task)
    .values({ id: taskId, kind, entityKind: 'lead', entityId: id, createdAt: hoursAgo(taskH) })
  return { id, taskId }
}

describe('one rule of what waits for Boris, in the bot and the pult (FR-LEAD-10)', () => {
  it('FR-LEAD-10: a day-old order no longer waits; one the summary offered today does; a closed or answered one never', () => {
    const t = (h: number) => ({ createdAt: hoursAgo(h) })
    const l = (h: number, status = 'queued') => ({ seenAt: hoursAgo(h), status })
    expect(waitEnd(t(1), l(1), NOW)).toBeNull()
    expect(waitEnd(t(25), l(25), NOW)).toBe('stale')
    expect(waitEnd(t(2), l(40, 'held'), NOW)).toBeNull()
    expect(waitEnd(t(1), l(1, 'closed'), NOW)).toBe('gone')
    expect(waitEnd(t(1), l(1, 'bid_sent'), NOW)).toBe('gone')
    // The card pass ends an aged-out order with this status: it never waits again, whatever its times say.
    expect(waitEnd(t(1), l(1, 'stale'), NOW)).toBe('gone')
  })

  it('FR-LEAD-10: the Inbox, the queue and the counts show the same tasks: none of the old or ended ones', async () => {
    const fresh = await waiting('lead_decision', 2)
    await waiting('lead_decision', 30)
    await waiting('lead_decision', 72)
    await waiting('lead_decision', 1, 1, 'closed')
    const held = await waiting('lead_held', 40, 3)
    await waiting('lead_held', 60, 50)
    await waiting('lead_review', 26, 26)

    const inbox = await inboxView(db, NOW)
    const leads = inbox.items.filter((i) => i.entity?.kind === 'lead')
    expect(leads.map((i) => i.entity?.id).sort()).toEqual([fresh.id, held.id].sort())
    expect(inbox.counts.leads).toBe(leads.length)
    const q = await leadQueue(db, NOW)
    expect(q.queue.map((r) => r.id)).toEqual([fresh.id])
    expect(q.older).toBe(0)
    expect(await openLeadCount(db, NOW)).toBe(1)
    expect(await waitingCounts(db, NOW)).toEqual({
      lead_decision: 1,
      lead_held: 1,
      lead_review: 0,
    })
  })

  it('FR-LEAD-10: the evening summary says in one line how many cards were folded as stale, nothing else about them', async () => {
    await seedDirection(db, 'hance-marketing')
    for (let i = 0; i < 3; i++)
      await appendEvent(db, {
        type: 'lead.stale',
        v: 1,
        entity: { kind: 'lead', id: String(97000000 + i) },
        account_id: null,
        actor: 'sara',
        occurred_at: hoursAgo(3),
        causation_id: null,
        correlation_id: newEventId(),
        reason: null,
        payload: { via: 'card', seen_at: hoursAgo(30) },
      })
    const sent: string[] = []
    const notifier: Notifier = {
      sendLeadCard: async () => ({ messageId: 1 }),
      closeLeadCard: async () => {},
      sendText: async (text) => {
        sent.push(text)
        return { messageId: 2 }
      },
      sendButtons: async (text) => {
        sent.push(text)
        return { messageId: 3 }
      },
    }
    // 30.10.2026, 19:30 in Moscow.
    expect(await dailySummary({ db, notifier }, new Date('2026-10-30T16:30:00Z'))).toBe('sent')
    expect(sent).toEqual(['Убрала 3 заявки старше суток, их карточки в боте свёрнуты'])
  })
})
