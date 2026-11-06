import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { onClientText } from '../../src/conversation/commands'
import { registerLoraRoute } from '../../src/conversation/loraRoute'
import {
  looksLikeReport,
  meetingsTick,
  readBorisResult,
  recordMeetingResult,
} from '../../src/conversation/meetings'
import { ensureConversation } from '../../src/conversation/store'
import { syncChat } from '../../src/conversation/sync'
import { deal, lead, meeting } from '../../src/db/schema'
import { createDeal } from '../../src/domain/deal'
import { meetingCard } from '../../src/notify/meetingCard'
import { setSetting } from '../../src/settings/store'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const ORDER = '95654676'
const ACC = 'hance-marketing'
let NOW = new Date('2026-11-05T09:00:00.000Z') // 12:00 Moscow, Thursday
let sent: { html: string; place: unknown }[]
let edits: { ref: number; html: string }[]
let reads: unknown[]
let dealId: string
let convId: string
const gateway = {
  call: async () => ({
    ok: true as const,
    output: reads.shift() ?? { kind: 'other' },
    durationMs: 1,
    modelCallId: 'm',
  }),
} as never
const notifier = {
  sendText: async (html: string, o?: { place?: unknown }) => {
    sent.push({ html, place: o?.place })
    return { messageId: -(700 + sent.length) }
  },
  editText: async (ref: number, html: string) => {
    edits.push({ ref, html })
  },
  pinPost: async () => {},
  forumOn: async () => true,
}
const deps = () => ({ db, gateway, notifier, now: () => NOW })

beforeEach(async () => {
  await resetDb(db)
  NOW = new Date('2026-11-05T09:00:00.000Z')
  sent = []
  edits = []
  reads = []
  await setSetting(db, 'pipeline.conversations', true, 'system')
  await db.insert(lead).values({
    id: ORDER,
    accountId: ACC,
    title: 'Консультация',
    category: 'Маркетинг',
    city: 'Москва',
    text: 'Нужна консультация',
    clientName: 'Анна',
    bidPriceRub: 290,
    seenAt: NOW.toISOString(),
    correlationId: newEventId(),
    status: 'bid_sent',
  })
  dealId = await createDeal(db, { leadId: ORDER, accountId: ACC, correlationId: newEventId() })
  const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
  convId = conv.id
  await syncChat(
    { db, profi: stubProfi([chatMsg('m1', 'client', 'Здравствуйте', '2026-11-05T08:00:00.000Z')]) },
    conv,
    NOW,
    { v1Writes: false },
  )
})

const stageNow = async () => (await db.select().from(deal).where(eq(deal.id, dealId)))[0]?.stage
const conv = async () =>
  await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })

/** A booked call at 15:30 that day, with its card out. */
async function booked() {
  const c = await conv()
  const id = newEventId()
  await db.insert(meeting).values({
    id,
    conversationId: c.id,
    title: 'Созвон',
    startsAt: '2026-11-05T12:30:00.000Z',
    status: 'booked',
    source: 'chat',
    how: 'phone',
    caller: 'we',
    cardRef: -650,
  })
  return id
}

describe('the outcome of a call', () => {
  it('FR-CONV-12: a held call gets its result and next step, the deal its done call, the card its new face', async () => {
    const id = await booked()
    await recordMeetingResult(
      deps(),
      await conv(),
      {
        held: true,
        result: 'Обсудили сайт',
        nextStep: 'Прислать КП',
        nextStepOn: '2026-11-06',
        source: 'lora',
      },
      NOW,
    )
    const [m] = await db.select().from(meeting)
    expect(m).toMatchObject({
      id,
      outcome: 'held',
      result: 'Обсудили сайт',
      nextStep: 'Прислать КП',
      nextStepOn: '2026-11-06',
      resultSource: 'lora',
    })
    expect(await stageNow()).toBe('call_done')
    expect(sent).toHaveLength(0)
    expect(edits).toHaveLength(1)
    expect(edits[0]?.ref).toBe(-650)
    expect(edits[0]?.html.split('\n')).toEqual([
      '✅ <b>Встреча прошла</b>',
      '<b>Четверг, 5 ноября, 15:30</b> · по Москве',
      'по телефону · звоним мы',
      '<b>Итог:</b> Обсудили сайт',
      '<b>Дальше:</b> Прислать КП · до 6 ноября',
    ])
  })

  it('FR-CONV-12: a call never written down is a meeting of its own when it is told; a missed one is not held', async () => {
    await recordMeetingResult(
      deps(),
      await conv(),
      {
        held: false,
        at: '2026-11-05T08:00:00.000Z',
        result: null,
        nextStep: 'Набрать ещё раз',
        nextStepOn: null,
        source: 'boris',
      },
      NOW,
    )
    const [m] = await db.select().from(meeting)
    expect(m).toMatchObject({ outcome: 'missed', source: 'boris' })
    expect(await stageNow()).toBe('talking')
    expect(sent[0]?.html).toContain('Встреча не состоялась')
  })

  it('FR-CONV-12: time alone proves nothing: after the time, a quiet «итога нет» on the card, no message, not counted held', async () => {
    const id = await booked()
    NOW = new Date('2026-11-05T16:00:00.000Z') // 19:00, more than 3 hours after 15:30
    await meetingsTick(deps(), NOW)
    const [m] = await db.select().from(meeting)
    expect(m?.outcome).toBeNull()
    expect(m?.expiredAt).not.toBeNull()
    expect(sent).toHaveLength(0)
    expect(edits.at(-1)?.html).toContain('Время встречи прошло, итога нет')
    expect(m?.id).toBe(id)
    // Once.
    edits = []
    await meetingsTick(deps(), new Date(NOW.getTime() + 60_000))
    expect(edits).toHaveLength(0)
  })

  it('FR-CONV-12: on the day of the next step one short reminder, in working hours, once', async () => {
    await booked()
    await recordMeetingResult(
      deps(),
      await conv(),
      {
        held: true,
        result: 'Обсудили',
        nextStep: 'Прислать КП',
        nextStepOn: '2026-11-06',
        source: 'lora',
      },
      NOW,
    )
    // The day before: nothing.
    await meetingsTick(deps(), NOW)
    expect(sent).toHaveLength(0)
    // The day of the step, at 7 in the morning: not in working hours.
    await meetingsTick(deps(), new Date('2026-11-06T04:00:00.000Z'))
    expect(sent).toHaveLength(0)
    // At 10: it goes, once.
    await meetingsTick(deps(), new Date('2026-11-06T07:00:00.000Z'))
    await meetingsTick(deps(), new Date('2026-11-06T08:00:00.000Z'))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.html).toBe('⏰ <b>Сегодня шаг по клиенту:</b> Прислать КП')
  })
})

describe('Boris tells how the call went', () => {
  it('FR-CONV-12: his story in the topic goes onto the card, and is not offered to the client', async () => {
    await booked()
    reads.push({
      kind: 'result',
      result: 'Обсудили сайт',
      next_step: 'Прислать КП',
      next_step_on: '2026-11-06',
    })
    const said = await readBorisResult(
      deps(),
      await conv(),
      'Созвонились, обсудили сайт, пришлю КП до пятницы',
    )
    expect(said).toContain('Записала итог встречи')
    expect((await db.select().from(meeting))[0]).toMatchObject({
      outcome: 'held',
      resultSource: 'boris',
      nextStepOn: '2026-11-06',
    })
    expect(edits.at(-1)?.html).toContain('Встреча прошла')
  })

  it('FR-CONV-12: words for the client, other words, and a text that is no story are left to the usual flow', async () => {
    reads.push({ kind: 'for_client' })
    expect(
      await readBorisResult(deps(), await conv(), 'Екатерина, созвонимся завтра, высылаю договор'),
    ).toBeNull()
    expect(looksLikeReport('Клиент интересный, из Краснодара')).toBe(false)
    expect(
      await readBorisResult(deps(), await conv(), 'Клиент интересный, из Краснодара'),
    ).toBeNull()
    expect(await db.select().from(meeting)).toHaveLength(0)
  })

  it('FR-CONV-12: "не дозвонился" is a call that did not take place', async () => {
    await booked()
    reads.push({ kind: 'not_held', next_step: 'Набрать завтра', next_step_on: '2026-11-06' })
    expect(
      await readBorisResult(deps(), await conv(), 'Не дозвонился, она не взяла трубку'),
    ).toContain('не состоялась')
    expect((await db.select().from(meeting))[0]).toMatchObject({ outcome: 'missed' })
    expect(await stageNow()).toBe('talking')
  })
})

describe('the hook in the topic', () => {
  it('FR-CONV-12: a story of a call is answered with a line and is not offered to the client', async () => {
    const c = await conv()
    const answer = await onClientText(
      {
        db,
        notifier: { sendText: notifier.sendText, closeTopic: async () => {} },
        meetingResult: async () => 'Записала итог встречи',
      },
      { conversationId: c.id, text: 'Созвонились, пришлю КП', voice: false, at: NOW },
    )
    expect(answer).toBe('Записала итог встречи')
    expect(sent).toHaveLength(0)
  })
})

describe('the input for Lora', () => {
  const app = async () => {
    const f = Fastify()
    registerLoraRoute(f, {
      db,
      token: 'lora-secret',
      record: async (c, r) => {
        await recordMeetingResult(
          deps(),
          c,
          {
            held: r.held ?? true,
            at: r.at ?? null,
            result: r.result,
            nextStep: r.next_step ?? null,
            nextStepOn: r.next_step_on ?? null,
            source: 'lora',
          },
          NOW,
        )
      },
    })
    return f
  }
  const post = (f: Awaited<ReturnType<typeof app>>, body: unknown, token = 'lora-secret') =>
    f.inject({
      method: 'POST',
      url: '/api/lora/meeting-result',
      headers: { 'x-sara-lora-token': token },
      payload: body as object,
    })

  it('FR-CONV-12: a note of hers is written once, a repeat of the same key changes nothing', async () => {
    await booked()
    const f = await app()
    const body = {
      key: 'note-1',
      order_id: ORDER,
      result: 'Обсудили сайт',
      next_step: 'Прислать КП',
      next_step_on: '2026-11-06',
    }
    const first = await post(f, body)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ accepted: true, duplicate: false })
    const again = await post(f, { ...body, result: 'Другое' })
    expect(again.json()).toEqual({ accepted: true, duplicate: true })
    const [m] = await db.select().from(meeting)
    expect(m).toMatchObject({ outcome: 'held', result: 'Обсудили сайт', resultSource: 'lora' })
    expect(await db.select().from(meeting)).toHaveLength(1)
  })

  it('FR-CONV-12: no token or a wrong one, a bad body and an unknown client are refused', async () => {
    const f = await app()
    expect((await post(f, { key: 'k', order_id: ORDER, result: 'x' }, 'wrong')).statusCode).toBe(
      401,
    )
    expect((await post(f, { key: 'k', result: 'x' })).statusCode).toBe(400)
    expect((await post(f, { key: 'k', order_id: ORDER })).statusCode).toBe(400)
    expect((await post(f, { key: 'k', order_id: '1', result: 'x' })).statusCode).toBe(404)
    const off = Fastify()
    registerLoraRoute(off, { db, token: undefined, record: async () => {} })
    expect(
      (await off.inject({ method: 'POST', url: '/api/lora/meeting-result', payload: {} }))
        .statusCode,
    ).toBe(503)
  })

  it('FR-CONV-12: the cards of the outcome read well when the call was not held and when it is only time passed', () => {
    expect(
      meetingCard(
        {
          status: 'missed',
          at: '2026-11-05T12:30:00.000Z',
          how: null,
          caller: null,
          quote: null,
          nextStep: 'Набрать ещё раз',
        },
        NOW,
      ),
    ).toContain('Встреча не состоялась')
    expect(
      meetingCard(
        { status: 'expired', at: '2026-11-05T12:30:00.000Z', how: null, caller: null, quote: null },
        NOW,
      ),
    ).toContain('итога нет')
  })
})
