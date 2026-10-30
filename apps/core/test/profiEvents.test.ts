import { type EventEnvelope, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedAccounts } from '../src/accounts/accounts'
import { handleProfiEvent } from '../src/accounts/profiEvents'
import { account } from '../src/db/schema'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)

let sent: string[]
const notifier = {
  sendText: async (t: string) => {
    sent.push(t)
    return { messageId: 1 }
  },
  sendLeadCard: async () => ({ messageId: 1 }),
}
beforeEach(async () => {
  await resetDb(db)
  sent = []
  await seedAccounts(db, [
    { id: 'hance-marketing', title: 'Hance маркетинг', egressIp: '127.0.0.1' },
  ])
})

const ev = (type: EventEnvelope['type'], payload: Record<string, unknown> = {}): EventEnvelope => ({
  id: newEventId(),
  type,
  v: 1,
  entity: { kind: 'account', id: 'hance-marketing' },
  account_id: 'hance-marketing',
  actor: 'profi',
  occurred_at: new Date().toISOString(),
  causation_id: null,
  correlation_id: newEventId(),
  reason: null,
  payload,
})
const d = () => ({ db, notifier, publicUrl: 'https://sara.example' })
const state = async () =>
  (await db.select().from(account).where(eq(account.id, 'hance-marketing')))[0]?.loginState

describe('Profi events in the core', () => {
  it('FR-OPS-2: logout marks the account dead and sends one alarm with the way back in', async () => {
    await handleProfiEvent(d(), ev('profi.session_dead'))
    expect(await state()).toBe('dead')
    expect(sent).toEqual([
      '🔴 Профи.ру разлогинил аккаунт Hance маркетинг. Пока ты не войдёшь, я ничего не вижу на этом аккаунте.\nВойти: https://sara.example/accounts/hance-marketing/login',
    ])
  })

  it('FR-OPS-2: a ban marks the account banned and sends one alarm', async () => {
    await handleProfiEvent(d(), ev('profi.profile_banned'))
    expect(await state()).toBe('banned')
    expect(sent).toEqual([
      '🚫 Профи.ру заблокировал профиль Hance маркетинг. Действия аккаунта остановлены.',
    ])
  })

  it('F8: the session back sends one green message', async () => {
    await handleProfiEvent(d(), ev('profi.session_dead'))
    await handleProfiEvent(d(), ev('profi.session_alive', { dead_since: new Date().toISOString() }))
    expect(await state()).toBe('alive')
    expect(sent.at(-1)).toBe(
      '🟢 Сессия Hance маркетинг снова живая. Сверяю, что пришло за время простоя.',
    )
  })

  it('NFR-UX-1: Profi event texts have no long dash', async () => {
    for (const t of ['profi.session_dead', 'profi.profile_banned'] as const)
      await handleProfiEvent(d(), ev(t))
    await handleProfiEvent(d(), ev('profi.session_alive', { dead_since: null }))
    for (const t of sent) expect(t).not.toContain(String.fromCharCode(0x2014))
  })
})

describe('routing of Profi events', () => {
  it('ST-M1-11: in shadow an order_seen is journaled but no card is sent', async () => {
    const { routeProfiEvent } = await import('../src/accounts/profiEvents')
    const { setSetting } = await import('../src/settings/store')
    const calls: string[] = []
    const r = {
      db,
      onOrderSeen: async () => {
        calls.push('pipeline')
      },
      onAccountEvent: async () => {
        calls.push('account')
      },
    }
    await routeProfiEvent(r, ev('profi.order_seen'))
    expect(calls).toEqual([])
    await setSetting(db, 'pipeline.leads', true, 'boris')
    await routeProfiEvent(r, ev('profi.order_seen'))
    await routeProfiEvent(r, ev('profi.session_dead'))
    expect(calls).toEqual(['pipeline', 'account'])
  })

  it('FR-LEAD-5: an order gone from the feed kicks the recheck, whatever the pipeline setting; nothing else hears it', async () => {
    const { routeProfiEvent } = await import('../src/accounts/profiEvents')
    const calls: string[] = []
    const r = {
      db,
      onOrderSeen: async () => {
        calls.push('pipeline')
      },
      onOrderGone: () => {
        calls.push('gone')
      },
      onAccountEvent: async () => {
        calls.push('account')
      },
      onConversationEvent: async () => {
        calls.push('conversation')
      },
    }
    await routeProfiEvent(r, ev('profi.order_gone', { page: 0 }))
    expect(calls).toEqual(['gone'])
  })

  it('FR-CONV-1: chat events go to the conversation', async () => {
    const { routeProfiEvent } = await import('../src/accounts/profiEvents')
    const calls: string[] = []
    const r = {
      db,
      onOrderSeen: async () => {},
      onAccountEvent: async () => {},
      onConversationEvent: async (e: { type: string }) => {
        calls.push(e.type)
      },
    }
    for (const t of [
      'profi.client_message',
      'profi.specialist_message',
      'profi.author_unclear',
      'profi.client_typing',
      'profi.client_read',
    ] as const)
      await routeProfiEvent(r, ev(t))
    await routeProfiEvent(r, ev('profi.session_dead'))
    expect(calls).toEqual([
      'profi.client_message',
      'profi.specialist_message',
      'profi.author_unclear',
      'profi.client_typing',
      'profi.client_read',
    ])
  })
})

describe('connection messages', () => {
  it('ADR-021: lost and back give one 🌐 each in plain words', async () => {
    // Now, so the outage is always today (a past moment could fall on yesterday near midnight).
    const since = new Date()
    const hhmm = since.toLocaleTimeString('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
    })
    await handleProfiEvent(d(), ev('profi.connection_lost', { since: since.toISOString() }))
    await handleProfiEvent(d(), ev('profi.connection_back', { since: since.toISOString() }))
    expect(sent).toEqual([
      `🌐 Нет связи с Профи.ру с ${hhmm}. Пробую раз в 5 минут.`,
      '🌐 Связь с Профи.ру вернулась. Сверяю, что пришло.',
    ])
  })

  it('ADR-021: an outage that began on another day shows the date too', async () => {
    const yesterday = new Date(Date.now() - 26 * 3600_000).toISOString()
    await handleProfiEvent(d(), ev('profi.connection_lost', { since: yesterday }))
    const day = new Date(yesterday).toLocaleDateString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
    })
    expect(sent.at(-1)).toContain(day)
  })
})
