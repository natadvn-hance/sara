import { DBOS } from '@dbos-inc/dbos-sdk'
import type { EventEnvelope } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { account } from '../db/schema'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { getSetting } from '../settings/store'

export type ProfiEventDeps = { db: Db; notifier: Pick<Notifier, 'sendText'>; publicUrl: string }

async function setState(db: Db, id: string, loginState: string): Promise<string> {
  const rows = await db
    .update(account)
    .set({ loginState, updatedAt: new Date().toISOString() })
    .where(eq(account.id, id))
    .returning({ title: account.title })
  return rows[0]?.title ?? id
}

/**
 * Account-level Profi events. Each arrives once (C8 dedupe by id) and the service sends them only on a
 * change of state, so one message per change reaches Boris (FR-OPS-2, F8).
 */
export async function handleProfiEvent(d: ProfiEventDeps, e: EventEnvelope): Promise<void> {
  const id = e.account_id ?? e.entity.id
  switch (e.type) {
    case 'profi.session_dead': {
      const title = await setState(d.db, id, 'dead')
      await d.notifier.sendText(TEXTS.sessionDead(title, `${d.publicUrl}/accounts/${id}/login`))
      return
    }
    case 'profi.profile_banned': {
      const title = await setState(d.db, id, 'banned')
      await d.notifier.sendText(TEXTS.banned(title))
      return
    }
    case 'profi.session_alive': {
      const title = await setState(d.db, id, 'alive')
      await d.notifier.sendText(TEXTS.sessionAlive(title))
      return
    }
    case 'profi.connection_lost': {
      const since = String((e.payload as { since?: string }).since ?? e.occurred_at)
      await d.notifier.sendText(TEXTS.connectionLost(moscowTime(since)))
      return
    }
    case 'profi.connection_back':
      await d.notifier.sendText(TEXTS.connectionBack)
      return
    default:
      return
  }
}

const moscowDay = (d: Date) =>
  d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' })

/** Time in Moscow; the date too when it was not today, so an outage over midnight is not ambiguous. */
const moscowTime = (iso: string) => {
  const d = new Date(iso)
  const time = d.toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  })
  return moscowDay(d) === moscowDay(new Date()) ? time : `${moscowDay(d)} ${time}`
}

let deps: ProfiEventDeps | null = null

const handleWorkflow = DBOS.registerWorkflow(
  async (e: EventEnvelope) => {
    const d = deps
    if (!d) throw new Error('Profi events are not configured')
    await DBOS.runStep(() => handleProfiEvent(d, e), {
      name: 'handle',
      retriesAllowed: true,
      maxAttempts: 5,
      intervalSeconds: 2,
    })
  },
  { name: 'profiAccountEvent' },
)

/** Account events run once per event id, even when the node delivers the same event again. */
export function createProfiEventDispatcher(d: ProfiEventDeps): (e: EventEnvelope) => Promise<void> {
  deps = d
  return async (e) => {
    await DBOS.startWorkflow(handleWorkflow, { workflowID: `profi-event:${e.id}` })(e)
  }
}

/**
 * Where a Profi event goes. In shadow (pipeline.leads off, the default) orders are only journaled, so the
 * new Sara does not double v1's summaries (ST-M1-11).
 */
export async function routeProfiEvent(
  r: {
    db: Db
    onOrderSeen(e: EventEnvelope): Promise<void>
    onAccountEvent(e: EventEnvelope): Promise<void>
    /** M4: chat events (FR-CONV-1); without it they are only journaled. */
    onConversationEvent?(e: EventEnvelope): Promise<void>
  },
  e: EventEnvelope,
): Promise<void> {
  if (e.type === 'profi.order_seen') {
    if (await getSetting(r.db, 'pipeline.leads')) await r.onOrderSeen(e)
    return
  }
  if (ACCOUNT_EVENTS.has(e.type)) await r.onAccountEvent(e)
  if (CHAT_EVENTS.has(e.type)) await r.onConversationEvent?.(e)
}

const CHAT_EVENTS = new Set<string>([
  'profi.client_message',
  'profi.specialist_message',
  'profi.author_unclear',
  'profi.client_typing',
  'profi.client_read',
])

const ACCOUNT_EVENTS = new Set<string>([
  'profi.session_dead',
  'profi.profile_banned',
  'profi.session_alive',
  'profi.connection_lost',
  'profi.connection_back',
])
