import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, lead, leadScore, task } from '../src/db/schema'
import { seedDirection } from '../src/direction/store'
import type { Gateway } from '../src/gateway/gateway'
import { createLeadPipeline, type LeadPipeline } from '../src/leads/pipeline'
import { type LeadCard, leadCardText, TEXTS, telegramTextLength } from '../src/notify/cards'
import type { Notifier } from '../src/notify/notifier'
import { analystAnswer } from './helpers/analyst'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)

let cards: LeadCard[] = []
let texts: { text: string; html: boolean }[] = []
/** Sends that fail from now on (Telegram not answering). */
let failSends = 0
const notifier: Notifier = {
  sendLeadCard: async (c) => {
    cards.push(c)
    return { messageId: 10 + cards.length }
  },
  sendText: async (text, o) => {
    if (failSends > 0) {
      failSends--
      throw new Error('telegram is down')
    }
    texts.push({ text, html: o?.html === true })
    return { messageId: 50 + texts.length }
  },
  sendButtons: async () => ({ messageId: 1 }),
}
let pipeline: LeadPipeline

const ANSWER = analystAnswer('Понимаю задачу.')
const ANALYSIS = {
  reading: ANSWER.reading,
  hidden_need: ANSWER.hidden_need,
  risk: ANSWER.risk,
  condition: ANSWER.condition,
}
const CLIENT = {
  name: 'Ирина',
  on_profi_since: 'На Профи.ру с 7 сентября 2020',
  phone_verified: true,
  reviews: { positive: 3, negative: 1 },
  review_tags: ['Перестала отвечать'],
}

beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  cards = []
  texts = []
  failSends = 0
  pipeline = createLeadPipeline({
    db,
    gateway: {} as Gateway,
    notifier,
    profi: { sessionHealth: async () => ({ alive: true, balance_rub: 5000 }) } as never,
    remindAfterMs: async () => 3_600_000,
  })
})

/** A lead with an open decision task; `over` sets the columns a test cares about. */
async function openLead(
  id: string,
  over: Partial<typeof lead.$inferInsert> = {},
  state: 'open' | 'resolved' = 'open',
): Promise<string> {
  const correlationId = newEventId()
  await db.insert(lead).values({
    id,
    accountId: 'hance-marketing',
    title: 'Сайт для клиники',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Нужен сайт для клиники.\nУслуги, врачи, запись.',
    clientName: 'Ирина',
    budgetText: 'до 150 000 ₽',
    bidPriceRub: 210,
    seenAt: new Date().toISOString(),
    status: 'queued',
    correlationId,
    draftText: 'Ирина, добрый день!\n\nПонимаю задачу.',
    draftPriceRub: 90000,
    draftAnalysis: ANALYSIS,
    clientInfo: CLIENT,
    ...over,
  })
  await db.insert(leadScore).values({
    id: newEventId(),
    leadId: id,
    version: 1,
    score: 68,
    decision: 'show',
    stopFactor: null,
    redFlags: [],
    axes: [],
    reason: 'Зрелый бизнес',
    confidence: 0.9,
    model: 'haiku',
  })
  const taskId = newEventId()
  await db.insert(task).values({
    id: taskId,
    kind: 'lead_decision',
    entityKind: 'lead',
    entityId: id,
    state,
    ...(state === 'resolved' && { resolution: 'skip', resolvedAt: new Date().toISOString() }),
  })
  return taskId
}
const events = async () => (await db.select({ type: event.type }).from(event)).map((e) => e.type)

describe('the card built from a lead', () => {
  it('FR-LEAD-7: a reminder card has the whole order, the client and the разбор from the lead row', async () => {
    const taskId = await openLead('91001')
    await pipeline.onReminder(taskId)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      taskId,
      orderId: '91001',
      title: 'Сайт для клиники',
      city: 'Краснодар',
      budgetText: 'до 150 000 ₽',
      clientName: 'Ирина',
      text: 'Нужен сайт для клиники.\nУслуги, врачи, запись.',
      clientInfo: CLIENT,
      reminder: true,
      analysis: {
        hiddenNeed: ANSWER.hidden_need,
        risk: ANSWER.risk,
        condition: ANSWER.condition,
        reading: ANSWER.reading,
      },
    })
    const text = leadCardText(cards[0] as LeadCard)
    expect(text).toContain('<b>⏰ Сайт для клиники</b>')
    expect(text).toContain('Отзывы: +3 / −1 · «Перестала отвечать»')
    expect(text).toContain('https://profi.ru/backoffice/n.php?o=91001')
  })

  it('FR-LEAD-7: a card sent again is the same layout without the reminder line', async () => {
    const taskId = await openLead('91002')
    await pipeline.resendCard(taskId)
    expect(cards[0]?.reminder).toBeFalsy()
    expect(leadCardText(cards[0] as LeadCard)).toContain('<b>🔔 Сайт для клиники</b>')
  })

  it('FR-LEAD-7: an old lead without reading, client info and draft gives a shorter card, not an error', async () => {
    const taskId = await openLead('91003', {
      draftText: null,
      draftPriceRub: null,
      draftAnalysis: null,
      clientInfo: null,
    })
    await expect(pipeline.onReminder(taskId)).resolves.toBeUndefined()
    const c = cards[0] as LeadCard
    expect(c.clientInfo).toBeNull()
    expect(c.analysis).toBeNull()
    const text = leadCardText(c)
    expect(text).toContain('<b>Клиент:</b> Ирина\n\n<b>Заявка</b>')
    expect(text).toContain('Черновика нет')
  })

  it('FR-LEAD-7: a stored reading or client info that no longer fits its shape is left out, not thrown on', async () => {
    const taskId = await openLead('91004', {
      draftAnalysis: { hidden_need: 5 },
      clientInfo: { reviews: 'много' },
    })
    await expect(pipeline.onReminder(taskId)).resolves.toBeUndefined()
    expect(cards[0]?.analysis).toBeNull()
    expect(cards[0]?.clientInfo).toBeNull()
  })

  it('FR-LEAD-7: a reading from before the full reading existed still gives its two lines', async () => {
    const taskId = await openLead('91005', {
      draftAnalysis: {
        hidden_need: ANSWER.hidden_need,
        risk: ANSWER.risk,
        condition: ANSWER.condition,
      },
    })
    await pipeline.onReminder(taskId)
    expect(cards[0]?.analysis).toMatchObject({ hiddenNeed: ANSWER.hidden_need, reading: null })
  })
})

describe('the «Разбор» press', () => {
  it('FR-LEAD-7: sends the full reading as its own HTML message once and answers', async () => {
    const taskId = await openLead('92001')
    const answer = await pipeline.onPress({ taskId, action: 'razbor' })
    expect(answer).toBe(TEXTS.analysisSent)
    expect(texts).toHaveLength(1)
    expect(texts[0]?.html).toBe(true)
    const msg = texts[0]?.text ?? ''
    expect(msg).toContain('<b>Разбор: Сайт для клиники</b>')
    expect(msg).toContain(ANSWER.reading.said)
    expect(msg).toContain(ANSWER.reading.layers)
    expect(msg).toContain(ANSWER.reading.wants)
    expect(msg).toContain(ANSWER.reading.who)
    expect(msg).toContain(ANSWER.reading.risks)
    expect(msg).toContain(ANSWER.reading.job)
    expect(msg).toContain(ANSWER.condition)
    expect(msg).toContain('https://profi.ru/backoffice/n.php?o=92001')
    expect(msg).not.toContain('Полный текст заявки')
    expect(cards).toHaveLength(0)
  })

  it('FR-LEAD-7: the press decides nothing: the task stays open and nothing is journaled', async () => {
    const taskId = await openLead('92002')
    const before = await events()
    await pipeline.onPress({ taskId, action: 'razbor' })
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t).toMatchObject({ state: 'open', resolution: null })
    expect(await events()).toEqual(before)
  })

  it('FR-LEAD-7: pressed again, and later from an old card after the order was decided, it sends again', async () => {
    const taskId = await openLead('92003', {}, 'resolved')
    await pipeline.onPress({ taskId, action: 'razbor' })
    await pipeline.onPress({ taskId, action: 'razbor' })
    expect(texts).toHaveLength(2)
    expect(texts[1]?.text).toBe(texts[0]?.text)
    const [t] = await db.select().from(task).where(eq(task.id, taskId))
    expect(t?.state).toBe('resolved')
  })

  it('FR-LEAD-7: a long order text, cut on the card, comes whole in the message', async () => {
    const text = `Начало заявки. ${'Подробности и ещё подробности. '.repeat(300)}Конец заявки.`
    const taskId = await openLead('92004', { text })
    await pipeline.onReminder(taskId)
    expect((cards[0] as LeadCard).text).toBe(text)
    expect(leadCardText(cards[0] as LeadCard)).toContain('…</blockquote>')
    await pipeline.onPress({ taskId, action: 'razbor' })
    expect(texts.length).toBeGreaterThan(1)
    expect(texts.every((t) => t.html)).toBe(true)
    const all = texts.map((t) => t.text).join('\n')
    expect(all).toContain('Начало заявки.')
    expect(all).toContain('Конец заявки.')
    for (const t of texts) expect(telegramTextLength(t.text)).toBeLessThanOrEqual(4096)
  })

  it('FR-LEAD-7: an old lead without a reading gets a message that says so, and the order text', async () => {
    const taskId = await openLead('92005', { draftAnalysis: null, draftText: null })
    expect(await pipeline.onPress({ taskId, action: 'razbor' })).toBe(TEXTS.analysisSent)
    expect(texts[0]?.text).toContain('Разбора для этой заявки нет')
    expect(texts[0]?.text).toContain('Нужен сайт для клиники.')
  })

  it('FR-LEAD-7: a stored reading that is broken is treated as none', async () => {
    const taskId = await openLead('92006', { draftAnalysis: 'сломано' })
    expect(await pipeline.onPress({ taskId, action: 'razbor' })).toBe(TEXTS.analysisSent)
    expect(texts[0]?.text).toContain('Разбора для этой заявки нет')
  })

  it('FR-LEAD-7: a task that does not exist gets a plain answer and sends nothing', async () => {
    expect(await pipeline.onPress({ taskId: newEventId(), action: 'razbor' })).toBe(TEXTS.noTask)
    expect(texts).toHaveLength(0)
  })

  it('FR-LEAD-7: a client text with tags and an ampersand is escaped in the message, the reading and the order text', async () => {
    const taskId = await openLead('92007', {
      title: 'A & B <b>',
      // Long enough that the card cuts it and the message carries it whole.
      text: '<script>x</script> & "q" '.repeat(200),
      draftAnalysis: {
        ...ANALYSIS,
        reading: { ...ANSWER.reading, said: '<i>сказал</i> & ушёл' },
      },
    })
    await pipeline.onPress({ taskId, action: 'razbor' })
    const all = texts.map((t) => t.text).join('\n')
    expect(all).toContain('<b>Разбор: A &amp; B &lt;b&gt;</b>')
    expect(all).toContain('&lt;i&gt;сказал&lt;/i&gt; &amp; ушёл')
    expect(all).toContain('&lt;script&gt;x&lt;/script&gt; &amp; "q" ')
    expect(all).not.toContain('<script>')
    expect(all).not.toContain('<i>сказал')
  })

  it('FR-LEAD-7: when Telegram does not take the message the press says so and works when pressed again', async () => {
    const taskId = await openLead('92009')
    failSends = 1
    expect(await pipeline.onPress({ taskId, action: 'razbor' })).toBe(TEXTS.analysisFailed)
    expect(texts).toHaveLength(0)
    expect(await pipeline.onPress({ taskId, action: 'razbor' })).toBe(TEXTS.analysisSent)
    expect(texts).toHaveLength(1)
  })
})
