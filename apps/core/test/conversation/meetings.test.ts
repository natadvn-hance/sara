import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  hasBookedMeeting,
  isFarewell,
  looksLikeMeeting,
  type MeetingRead,
  parseMoscow,
  readMeeting,
} from '../../src/conversation/meetings'
import { waitingClients } from '../../src/conversation/owed'
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

const ORDER = '95680762'
const ACC = 'hance-marketing'
const NOW = new Date('2026-11-04T09:00:00.000Z') // 12:00 in Moscow, a Wednesday
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()

let reads: MeetingRead[]
let calls: string[]
let sent: { html: string; place: unknown }[]
let edits: { ref: number; html: string }[]
let pins: number[]
const gateway = {
  call: async (_role: string, input: string) => {
    calls.push(input)
    const output = reads.shift() ?? { status: 'none' as const }
    return { ok: true as const, output, durationMs: 1, modelCallId: 'm' }
  },
} as never
const notifier = {
  sendText: async (html: string, o?: { place?: unknown }) => {
    sent.push({ html, place: o?.place })
    return { messageId: -(500 + sent.length) }
  },
  editText: async (ref: number, html: string) => {
    edits.push({ ref, html })
  },
  pinPost: async (ref: number) => {
    pins.push(ref)
  },
  forumOn: async () => true,
}
const deps = { db, gateway, notifier, now: () => NOW }
let dealId: string

/** The chat as it stands: (author, text, minutes ago), stored as the sync stores it. */
async function chat(msgs: ['client' | 'specialist', string, number][]) {
  const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
  const profi = stubProfi(
    msgs.map(([side, text, min], k) => chatMsg(`m${k}`, side, text, ago(min))),
  )
  const r = await syncChat({ db, profi }, conv, NOW, { v1Writes: false })
  return { conv, added: r.added }
}

beforeEach(async () => {
  await resetDb(db)
  reads = []
  calls = []
  sent = []
  edits = []
  pins = []
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
})

const stageNow = async () => (await db.select().from(deal).where(eq(deal.id, dealId)))[0]?.stage

describe('the cheap gate', () => {
  it('FR-CONV-12: words of a call with a time or a number pass; talk of other things does not', () => {
    expect(
      looksLikeMeeting([
        'могу попросить вас набрать Екатерине завтра по номеру 8900 123-45-67 в 15:30?',
      ]),
    ).toBe(true)
    expect(looksLikeMeeting(['давайте созвонимся в четверг'])).toBe(true)
    expect(looksLikeMeeting(['мне удобно сейчас и не голосом'])).toBe(false)
    expect(looksLikeMeeting(['сколько стоит сайт в 2026 году?'])).toBe(false)
  })

  it('FR-CONV-12: a parting word is no message left unanswered, a question is', () => {
    for (const t of [
      'Большое спасибо)',
      'Договорились) Благодарю',
      'Хорошо.',
      'Ок',
      'До связи!',
      'Принято',
    ])
      expect(isFarewell(t)).toBe(true)
    for (const t of [
      'Спасибо, а можно скидку?',
      'Хорошо, а сколько стоит?',
      'Покажите примеры',
      '',
    ])
      expect(isFarewell(t)).toBe(false)
  })

  it('FR-CONV-12: the Moscow time of the model is read as such', () => {
    expect(parseMoscow('2026-11-05 15:30')?.toISOString()).toBe('2026-11-05T12:30:00.000Z')
    expect(parseMoscow('завтра')).toBeNull()
    expect(parseMoscow(null)).toBeNull()
  })
})

describe('a call booked in the chat', () => {
  it('FR-CONV-12 (а): the client asks to call at 15:30 and we agree: the stage, the meeting and a pinned card follow', async () => {
    const { conv, added } = await chat([
      ['specialist', 'Добрый день! Готов обсудить задачу.', 600],
      [
        'client',
        'Могу попросить вас набрать Екатерине завтра по номеру 8900 123-45-67 в 15:30? Она может с 15:00 до 16:00',
        30,
      ],
      ['specialist', 'Договорились, завтра наберу', 10],
    ])
    reads.push({
      status: 'booked',
      at: '2026-11-05 15:30',
      how: 'phone',
      caller: 'we',
      quote: 'Договорились, завтра наберу',
    })
    await readMeeting(deps, conv, added)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('Клиент:')
    expect(await stageNow()).toBe('call_booked')
    const [m] = await db.select().from(meeting)
    expect(m).toMatchObject({
      status: 'booked',
      source: 'chat',
      how: 'phone',
      caller: 'we',
      conversationId: conv.id,
    })
    expect(new Date(m?.startsAt ?? '').toISOString()).toBe('2026-11-05T12:30:00.000Z')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.place).toEqual({ conversation: conv.id })
    expect(sent[0]?.html).toContain('Созвон назначен')
    expect(sent[0]?.html).toContain('Четверг, 5 ноября, 15:30')
    expect(pins).toEqual([-501])
    expect(await hasBookedMeeting(db, conv.id)).toBe(true)
  })

  it('FR-CONV-12 (б): no firm time ("как получится"): only a note, no stage, no slot, no pin', async () => {
    const { conv, added } = await chat([
      ['client', 'Если возможно созвон в 16.00', 90],
      ['specialist', 'Сегодня в 16:00 не успеваю', 80],
      ['client', 'А если в 17:00?', 70],
      ['specialist', 'В 17.00 уже занят, напишу ближе к 16:00', 60],
      ['client', 'Хорошо. Как получится', 30],
    ])
    reads.push({ status: 'maybe', at: null, quote: 'напишу ближе к 16:00' })
    await readMeeting(deps, conv, added)
    // The client's word moved the deal to talking; the call is not booked.
    expect(await stageNow()).toBe('talking')
    const [m] = await db.select().from(meeting)
    expect(m).toMatchObject({ status: 'maybe', startsAt: null })
    expect(sent[0]?.html).toContain('Похоже, договорились')
    expect(pins).toEqual([])
    expect(await hasBookedMeeting(db, conv.id)).toBe(false)
  })

  it('FR-CONV-12 (в): times offered with no answer are no agreement', async () => {
    const { conv, added } = await chat([
      ['specialist', 'Могу созвониться завтра в 12:00 или в четверг в 15:00, как удобно?', 60],
    ])
    reads.push({ status: 'proposed', at: '2026-11-05 12:00' })
    await readMeeting(deps, conv, added)
    expect(await db.select().from(meeting)).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect(await stageNow()).toBe('bid_sent')
  })

  it('FR-CONV-12 (г): "удобно сейчас и не голосом" does not even reach the model', async () => {
    const { conv, added } = await chat([['client', 'мне удобно сейчас и не голосом', 5]])
    await readMeeting(deps, conv, added)
    expect(calls).toHaveLength(0)
    expect(await db.select().from(meeting)).toHaveLength(0)
  })

  it('FR-CONV-12 (д): a move edits the same meeting and the same card', async () => {
    const first = await chat([
      ['specialist', 'наберу завтра в 12', 60],
      ['client', 'Договорились', 50],
    ])
    reads.push({
      status: 'booked',
      at: '2026-11-05 12:00',
      how: 'phone',
      caller: 'we',
      quote: 'Договорились',
    })
    await readMeeting(deps, first.conv, first.added)
    expect(sent).toHaveLength(1)
    const second = await chat([
      ['specialist', 'наберу завтра в 12', 60],
      ['client', 'Договорились', 50],
      ['client', 'давайте перенесем на четверг, в 15:00 созвон', 5],
    ])
    reads.push({
      status: 'rescheduled',
      at: '2026-11-06 15:00',
      quote: 'давайте перенесем на четверг',
    })
    await readMeeting(deps, second.conv, second.added)
    const rows = await db.select().from(meeting)
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0]?.startsAt ?? '').toISOString()).toBe('2026-11-06T12:00:00.000Z')
    expect(sent).toHaveLength(1)
    expect(edits).toHaveLength(1)
    expect(edits[0]?.ref).toBe(-501)
    expect(edits[0]?.html).toContain('Перенесено, было четверг, 5 ноября, 12:00')
    expect(edits[0]?.html).toContain('6 ноября, 15:00')
  })

  it('FR-CONV-12: a cancelled call frees the slot and the card says so; the same message is read once', async () => {
    const first = await chat([
      ['specialist', 'наберу завтра в 12', 60],
      ['client', 'Договорились', 50],
    ])
    reads.push({ status: 'booked', at: '2026-11-05 12:00', quote: 'Договорились' })
    await readMeeting(deps, first.conv, first.added)
    const second = await chat([
      ['specialist', 'наберу завтра в 12', 60],
      ['client', 'Договорились', 50],
      ['client', 'созвон отменяется, не получится завтра', 5],
    ])
    reads.push({ status: 'cancelled', quote: 'созвон отменяется' })
    await readMeeting(deps, second.conv, second.added)
    expect((await db.select().from(meeting))[0]).toMatchObject({
      status: 'cancelled',
      outcome: 'cancelled',
    })
    expect(edits.at(-1)?.html).toContain('Созвон отменён')
    expect(await hasBookedMeeting(db, second.conv.id)).toBe(false)
    const callsBefore = calls.length
    await readMeeting(deps, second.conv, second.added)
    expect(calls).toHaveLength(callsBefore)
  })

  it('FR-CONV-12: a card still comes when the bot may not pin: no error, no noise', async () => {
    const quiet = {
      ...deps,
      notifier: {
        ...notifier,
        pinPost: async () => {
          throw new Error('not enough rights to pin a message')
        },
      },
    }
    const { conv, added } = await chat([
      ['specialist', 'наберу завтра в 12', 60],
      ['client', 'Договорились', 50],
    ])
    reads.push({ status: 'booked', at: '2026-11-05 12:00', quote: 'Договорились' })
    await readMeeting(quiet, conv, added)
    expect(sent).toHaveLength(1)
    expect(await stageNow()).toBe('call_booked')
  })

  it('FR-CONV-12 (и): "мне удобно сейчас и не голосом, завтра не актуально" withdraws a standing «похоже»', async () => {
    const first = await chat([['client', 'Хорошо. Как получится, созвон ближе к 16:00', 40]])
    reads.push({ status: 'maybe', at: null, quote: 'Как получится' })
    await readMeeting(deps, first.conv, first.added)
    const second = await chat([
      ['client', 'Хорошо. Как получится, созвон ближе к 16:00', 40],
      [
        'client',
        'мне удобно сейчас и не голосом. завтра уже будет не актуально, созвон не нужен в 16:00',
        5,
      ],
    ])
    reads.push({ status: 'cancelled', quote: 'мне удобно сейчас и не голосом' })
    await readMeeting(deps, second.conv, second.added)
    expect((await db.select().from(meeting))[0]).toMatchObject({
      status: 'cancelled',
      outcome: 'cancelled',
    })
    expect(edits.at(-1)?.html).toContain('Договорённость о созвоне снята')
  })

  it('FR-CONV-12: a model that gives no answer (a limit) leaves the message to be read again', async () => {
    const { conv, added } = await chat([['client', 'давайте созвонимся завтра в 15:00', 5]])
    const limited = {
      ...deps,
      gateway: {
        call: async () => ({
          ok: false,
          errorClass: 'limit_reached',
          message: '',
          durationMs: 1,
          modelCallId: 'x',
        }),
      } as never,
    }
    await readMeeting(limited, conv, added)
    reads.push({ status: 'booked', at: '2026-11-05 15:00' })
    await readMeeting(deps, conv, added)
    expect(await stageNow()).toBe('call_booked')
  })
})

describe('no waiting and no reminders while a call stands', () => {
  it('FR-CONV-12: a booked call, or a parting word, means nobody waits for an answer', async () => {
    const { conv } = await chat([['client', 'Покажите примеры', 40]])
    expect((await waitingClients({ db }, NOW)).map((w) => w.conversationId)).toEqual([conv.id])
    await db.insert(meeting).values({
      id: newEventId(),
      conversationId: conv.id,
      title: 'Созвон',
      startsAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
      status: 'booked',
      source: 'chat',
    })
    expect(await waitingClients({ db }, NOW)).toEqual([])
    await resetDb(db)
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
    await chat([['client', 'Договорились) Благодарю', 40]])
    expect(await waitingClients({ db }, NOW)).toEqual([])
  })

  it('FR-CONV-12: the card is plain Telegram HTML with the facts in it', () => {
    const html = meetingCard(
      {
        status: 'booked',
        at: '2026-11-05T12:30:00.000Z',
        how: 'phone',
        caller: 'we',
        quote: 'Договорились, завтра <наберу>',
      },
      NOW,
    )
    expect(html.split('\n')).toEqual([
      '📞 <b>Созвон назначен</b>',
      '<b>Четверг, 5 ноября, 15:30</b> · по Москве',
      'по телефону · звоним мы',
      '<blockquote>Договорились, завтра &lt;наберу&gt;</blockquote>',
    ])
  })
})
