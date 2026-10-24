import { describe, expect, it } from 'vitest'
import { type AttributionContext, attribute, V1_TEMPLATES } from '../../src/history/attribution'
import type { V1Lead } from '../../src/history/v1Snapshot'

const lead = (over: Partial<V1Lead> = {}): V1Lead => ({
  orderId: '7001',
  clientName: 'Ирина',
  description: 'Нужен сайт для студии',
  category: 'Сайты',
  city: 'Москва',
  status: 'responded',
  draftResponse: null,
  draftResponseOriginal: null,
  respondedAt: null,
  borisWroteText: null,
  borisWroteAt: null,
  takenByBorisAt: null,
  dictatedReply: null,
  proposedReply: null,
  replyApprovedAt: null,
  customerReply: null,
  createdAt: '2026-09-10T07:50:00.000Z',
  updatedAt: '2026-09-11T09:00:00.000Z',
  ...over,
})

const ctx = (over: Partial<AttributionContext> = {}): AttributionContext => ({
  v1StartedAt: '2026-09-09T16:14:00.000Z',
  lead: lead(),
  v1Texts: new Set(),
  ourOutbox: [],
  v1Writes: true,
  ...over,
})

const at = '2026-10-01T10:00:00.000Z'
const LONG_DASH = String.fromCodePoint(0x2014)
const spec = (
  text: string,
  over: { sentAt?: string; approxTime?: boolean; inBid?: boolean } = {},
) => ({
  side: 'specialist' as const,
  text,
  sentAt: at,
  ...over,
})

describe('attribution', () => {
  it('FR-TRAIN-1: client, system and unknown sides keep their side as the author', () => {
    expect(attribute({ side: 'client', text: 'Сколько стоит?', sentAt: at }, ctx())).toEqual({
      author: 'client',
      basis: 'side',
    })
    expect(attribute({ side: 'system', text: 'Заказ закрыт', sentAt: at }, ctx())).toEqual({
      author: 'system',
      basis: 'side',
    })
    expect(attribute({ side: 'unknown', text: 'что-то', sentAt: at }, ctx())).toEqual({
      author: 'unknown',
      basis: 'side',
    })
  })

  it('FR-TRAIN-1: a message our outbox sent within 10 minutes is the new Sara', () => {
    const c = ctx({ ourOutbox: [{ text: 'Добрый день! Удобно созвониться завтра?', at }] })
    expect(attribute(spec('добрый день! удобно созвониться завтра?'), c)).toEqual({
      author: 'sara',
      basis: 'outbox',
    })
    const later = new Date(Date.parse(at) + 11 * 60_000).toISOString()
    expect(
      attribute(spec('Добрый день! Удобно созвониться завтра?', { sentAt: later }), c),
    ).toEqual({
      author: 'unknown',
      basis: 'v1_or_boris',
    })
  })

  it('FR-TRAIN-1: a first reading of the chat still finds our message sent before it', () => {
    const c = ctx({ ourOutbox: [{ text: 'Пришлю смету вечером', at }] })
    const readAt = new Date(Date.parse(at) + 3 * 3600_000).toISOString()
    expect(
      attribute(spec('Пришлю смету вечером', { sentAt: readAt, approxTime: true }), c),
    ).toEqual({
      author: 'sara',
      basis: 'outbox',
    })
  })

  it('FR-TRAIN-1: words Boris dictated to the new Sara are his', () => {
    const c = ctx({ ourOutbox: [{ text: 'Цена 80 тысяч, срок месяц', at, author: 'boris' }] })
    expect(attribute(spec('Цена 80 тысяч, срок месяц'), c)).toEqual({
      author: 'boris',
      basis: 'say',
    })
  })

  it('FR-TRAIN-1: the bid the new Sara sent is hers in the bid place of the chat', () => {
    const c = ctx({ ourBid: 'Здравствуйте! Сделаем сайт за месяц.' })
    expect(attribute(spec('Здравствуйте! Сделаем сайт за месяц.', { inBid: true }), c)).toEqual({
      author: 'sara',
      basis: 'outbox',
    })
    expect(attribute(spec('Стоимость: 50 000 ₽', { inBid: true }), c)).toEqual({
      author: 'sara',
      basis: 'outbox',
    })
  })

  it('FR-TRAIN-1: a message sent before v1 started is Boris', () => {
    expect(attribute(spec('Добрый день', { sentAt: '2026-09-01T10:00:00.000Z' }), ctx())).toEqual({
      author: 'boris',
      basis: 'before_v1',
    })
  })

  it('FR-TRAIN-1: an approximate time proves neither before v1 nor after «беру сам»', () => {
    const c = ctx({ lead: lead({ takenByBorisAt: '2026-09-20T10:00:00.000Z' }) })
    expect(
      attribute(spec('Добрый день', { sentAt: '2026-09-01T10:00:00.000Z', approxTime: true }), c),
    ).toEqual({ author: 'unknown', basis: 'v1_or_boris' })
    expect(attribute(spec('Добрый день', { approxTime: true }), c)).toEqual({
      author: 'unknown',
      basis: 'v1_or_boris',
    })
  })

  it("FR-TRAIN-1: Boris's words glued by v1 are found as a paragraph", () => {
    const c = ctx({
      lead: lead({
        borisWroteText: 'Добрый день, посмотрел ваш бриф.\n\nЗавтра пришлю смету. Хорошо?',
      }),
    })
    expect(attribute(spec('Завтра пришлю смету. Хорошо?'), c)).toEqual({
      author: 'boris',
      basis: 'v1_boris_text',
    })
    expect(
      attribute(spec('Добрый день, посмотрел ваш бриф.\nЗавтра пришлю смету. Хорошо?'), c),
    ).toEqual({ author: 'boris', basis: 'v1_boris_text' })
    // A word inside his paragraph is not his message.
    expect(attribute(spec('Хорошо'), c)).toEqual({ author: 'unknown', basis: 'v1_or_boris' })
  })

  it("FR-TRAIN-1: the cut start of Boris's words still proves his message", () => {
    const message = 'Созвонимся? Скажите, вам удобно в четверг после обеда?'
    const glued = `${message}\n\n${'Пришлю договор. '.repeat(60)}`.slice(-1000)
    expect(glued.startsWith(message)).toBe(false)
    const c = ctx({ lead: lead({ borisWroteText: glued }) })
    expect(attribute(spec(message), c)).toEqual({ author: 'boris', basis: 'v1_boris_text' })
  })

  it('FR-TRAIN-1: the text Boris dictated to v1 is his', () => {
    const c = ctx({ lead: lead({ dictatedReply: `Ещё ${LONG_DASH} пара\nвопросов  по  СРОКАМ` }) })
    expect(attribute(spec('еще - пара вопросов по срокам'), c)).toEqual({
      author: 'boris',
      basis: 'v1_dictated',
    })
  })

  it('FR-TRAIN-1: after «беру сам» a specialist message is Boris', () => {
    const c = ctx({ lead: lead({ takenByBorisAt: '2026-09-20T10:00:00.000Z' }) })
    expect(attribute(spec('Перезвоню через час'), c)).toEqual({
      author: 'boris',
      basis: 'v1_taken',
    })
    expect(
      attribute(spec('Перезвоню через час', { sentAt: '2026-09-19T10:00:00.000Z' }), c),
    ).toEqual({
      author: 'unknown',
      basis: 'v1_or_boris',
    })
  })

  it('FR-TRAIN-1: the v1 bid, its approved draft, its ready texts and the Telegram copy are old Sara', () => {
    const c = ctx({
      lead: lead({
        draftResponse: 'Здравствуйте, Ирина! Сделаем сайт.',
        respondedAt: '2026-09-10T08:00:00.000Z',
        proposedReply: 'Давайте обсудим детали по телефону',
      }),
      v1Texts: new Set(['спасибо, жду ваших новостей']),
    })
    expect(attribute(spec('Здравствуйте, Ирина! Сделаем сайт.'), c)).toEqual({
      author: 'sara_v1',
      basis: 'v1_bid',
    })
    expect(attribute(spec('Стоимость: 40 000 ₽', { inBid: true }), c)).toEqual({
      author: 'sara_v1',
      basis: 'v1_bid',
    })
    expect(attribute(spec('Давайте обсудим детали по телефону.'), c)).toEqual({
      author: 'sara_v1',
      basis: 'v1_proposed',
    })
    expect(attribute(spec('Спасибо, жду ваших новостей!'), c)).toEqual({
      author: 'sara_v1',
      basis: 'telegram_export',
    })
  })

  it('FR-TRAIN-1: «Стоимость» away from the bid place proves nothing', () => {
    const c = ctx({
      lead: lead({ draftResponse: 'Сделаем.', respondedAt: '2026-09-10T08:00:00.000Z' }),
    })
    expect(attribute(spec('Стоимость: 40 000 ₽'), c)).toEqual({
      author: 'unknown',
      basis: 'v1_or_boris',
    })
  })

  it('FR-TRAIN-1: the ready-made v1 texts are found with or without a name', () => {
    const [call, friendly, business, meeting] = V1_TEMPLATES
    const c = ctx()
    for (const t of [call, friendly, business]) {
      expect(attribute(spec(t ?? ''), c)).toEqual({ author: 'sara_v1', basis: 'v1_template' })
    }
    expect(attribute(spec(`Ирина, з${(friendly ?? '').slice(1)}`), c)).toEqual({
      author: 'sara_v1',
      basis: 'v1_template',
    })
    expect(attribute(spec(`${meeting} 2 октября, 15:00. Скину напоминание накануне.`), c)).toEqual({
      author: 'sara_v1',
      basis: 'v1_template',
    })
    expect(attribute(spec(`Вот что скажу: з${(friendly ?? '').slice(1)}`), c)).toEqual({
      author: 'unknown',
      basis: 'v1_or_boris',
    })
  })

  it('FR-TRAIN-1: a bid Boris edited is sara_v1, not his voice', () => {
    const c = ctx({
      lead: lead({
        draftResponse: 'Здравствуйте! Сделаем сайт за 3 недели.',
        draftResponseOriginal: 'Здравствуйте! Сделаем сайт.',
        respondedAt: '2026-09-10T08:00:00.000Z',
      }),
    })
    expect(attribute(spec('Здравствуйте! Сделаем сайт за 3 недели.'), c)).toEqual({
      author: 'sara_v1',
      basis: 'v1_bid_edited',
    })
  })

  it("FR-CONV-10: after the switch every specialist message that is not ours is Boris's", () => {
    const c = ctx({ v1Writes: false, ourOutbox: [{ text: 'Наш ответ', at }] })
    expect(attribute(spec('Сам напишу клиенту'), c)).toEqual({
      author: 'boris',
      basis: 'after_cutover',
    })
    expect(attribute(spec('Наш ответ'), c)).toEqual({ author: 'sara', basis: 'outbox' })
  })

  it('FR-TRAIN-1: a specialist message with no proof is unknown, never boris', () => {
    expect(attribute(spec('Добрый вечер! Подскажите бюджет?'), ctx())).toEqual({
      author: 'unknown',
      basis: 'v1_or_boris',
    })
    expect(attribute(spec('Добрый вечер!'), ctx({ lead: null, v1StartedAt: null }))).toEqual({
      author: 'unknown',
      basis: 'v1_or_boris',
    })
  })

  it('FR-TRAIN-1: an empty specialist message matches no text proof', () => {
    const c = ctx({ lead: lead({ dictatedReply: '', proposedReply: '!!' }) })
    expect(attribute(spec('...'), c)).toEqual({ author: 'unknown', basis: 'v1_or_boris' })
  })
})
