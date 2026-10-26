import { ExamScenario, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { chatMessage, event, lead, mindProposal } from '../../src/db/schema'
import { buildScenarios } from '../../src/exam/build'
import { redact } from '../../src/gateway/redact'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

type Msg = [author: string, text: string, at: string]

let seq = 0
/** A chat of the history as the export leaves it: ours is `boris` only with proof. */
async function chat(
  chatId: string,
  messages: Msg[],
  o: { orderId?: string; client?: string } = {},
) {
  const orderId = o.orderId ?? `order-${chatId}`
  if (o.client !== undefined)
    await db.insert(lead).values({
      id: orderId,
      accountId: 'hance-marketing',
      title: 'Сайт для клиники Анны',
      category: 'Сайты',
      city: 'Краснодар',
      text: `Нужен сайт, пишите Анне на anna@example.com или звоните +7 916 123-45-67`,
      clientName: o.client,
      bidPriceRub: 100,
      seenAt: '2026-10-01T10:00:00Z',
      correlationId: newEventId(),
    })
  for (const [author, text, at] of messages) {
    await db.insert(chatMessage).values({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId,
      orderId,
      platformMessageId: `m-${++seq}`,
      side: author === 'client' ? 'client' : 'specialist',
      author,
      authorBasis: author === 'client' ? 'side' : 'v1_boris_text',
      text,
      sentAt: at,
      source: 'v1',
    })
  }
}

const BID = 'Анна, добрый день! Увидели ваш заказ, давайте обсудим задачу.'

const proposals = () => db.select().from(mindProposal).orderBy(mindProposal.path)

describe('buildScenarios', { timeout: 30_000 }, () => {
  it('FR-TRAIN-8: a client turn and the answer of Boris become a proposed scenario, depersonalized', async () => {
    await chat(
      'c1',
      [
        ['sara_v1', BID, '2026-10-01T10:00:00Z'],
        [
          'client',
          'Здравствуйте, это Анна. Сколько стоит сайт? Мой телефон +7 916 123-45-67, почта anna@example.com, наш сайт https://anna-clinic.ru',
          '2026-10-01T10:30:00Z',
        ],
        [
          'boris',
          'Анна, добрый день! Цена зависит от задачи. Напишите на boris@hance.ru или звоните +7 918 000-11-22, всё обсудим.',
          '2026-10-01T11:00:00Z',
        ],
      ],
      { client: 'Анна' },
    )
    expect(await buildScenarios(db, { limit: 10 })).toBe(1)
    const rows = await proposals()
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({
      path: 'exam/scenarios/x-h-1.json',
      kind: 'scenario',
      state: 'new',
    })
    expect(row?.source).toMatch(/^history:[0-9a-f]{12}$/)

    const s = ExamScenario.parse(JSON.parse(row?.content ?? ''))
    expect(s.id).toBe('x-h-1')
    expect(s.golden).toBe(false)
    expect(s.source.kind).toBe('history')
    expect(s.source.ref).toMatch(/^[0-9a-f]{12}$/)
    expect(s.messages.at(-1)?.author).toBe('client')
    expect(s.expect.boris_reply).toContain('Цена зависит от задачи')
    // The price is Boris's: a history question about the price expects a call for Boris.
    expect(s.expect.move).toBe('call_boris')
    expect(s.expect.topic).toBe('price')
    // The time to answer is when Boris answered.
    expect(s.now).toBe('2026-10-01T11:00:00Z')

    // No name, phone, e-mail or link of the client or of Boris is left anywhere in the file.
    const text = row?.content ?? ''
    for (const leak of [
      'Анна',
      'Анны',
      'Анне',
      '916',
      '123-45-67',
      'anna',
      '@',
      'https',
      'hance.ru',
      '918',
    ])
      expect(text, `leaked ${leak}`).not.toContain(leak)
    const hidden = redact(text).counts
    expect(hidden.phone + hidden.email + hidden.link).toBe(0)
    expect(s.client_name).toBe('[имя 1]')
    expect(s.messages[0]?.text).toContain('[имя 1]')
    expect(s.order.title).not.toContain('Анн')
  })

  it('NFR-PRIV-2: a name that only Boris or the client said is hidden when the bid greeted no one', async () => {
    // The bid of old Sara said only «Добрый день!», and there is no lead: the names are in the other messages.
    await chat('c1', [
      [
        'sara_v1',
        'Добрый день! Увидели ваш заказ, давайте обсудим задачу.',
        '2026-10-01T10:00:00Z',
      ],
      ['client', 'Здравствуйте, это Ирина Петрова. Сколько стоит сайт?', '2026-10-01T10:30:00Z'],
      [
        'boris',
        'Ирина, добрый день! Цена зависит от задачи, давайте обсудим.',
        '2026-10-01T11:00:00Z',
      ],
    ])
    expect(await buildScenarios(db, { limit: 5 })).toBe(1)
    const text = (await proposals())[0]?.content ?? ''
    for (const leak of ['Ирин', 'Петров']) expect(text, `leaked ${leak}`).not.toContain(leak)
    const s = ExamScenario.parse(JSON.parse(text))
    expect(s.client_name).toBe('[имя 1]')
    expect(s.messages.map((m) => m.text).join(' ')).toContain('[имя 1]')
    expect(s.expect.boris_reply).toContain('[имя 1], добрый день')
  })

  it('NFR-PRIV-2: «меня зовут X» of the client and a name from a later message of ours are hidden too', async () => {
    await chat('c1', [
      ['sara_v1', 'Добрый день! Увидели ваш заказ.', '2026-10-01T10:00:00Z'],
      ['sara_v1', 'Олег, смотрим ваш заказ внимательнее.', '2026-10-01T10:05:00Z'],
      [
        'client',
        'Меня зовут Мария Сидорова. Подскажите, как будем работать?',
        '2026-10-01T10:30:00Z',
      ],
      ['boris', 'Начнём с короткого созвона, расскажу как идёт работа.', '2026-10-01T11:00:00Z'],
    ])
    expect(await buildScenarios(db, { limit: 5 })).toBe(1)
    const text = (await proposals())[0]?.content ?? ''
    for (const leak of ['Олег', 'Мария', 'Сидоров'])
      expect(text, `leaked ${leak}`).not.toContain(leak)
  })

  it('NFR-PRIV-2: a message that opens with a name the builder cannot know is not proposed at all', async () => {
    // «Anna,» is no name the rules find, and no lead names her: the scenario would leak it, so it is left out.
    await chat('c1', [
      ['sara_v1', 'Добрый день! Увидели ваш заказ.', '2026-10-01T10:00:00Z'],
      ['client', 'Anna, подскажите, сколько стоит сайт?', '2026-10-01T10:30:00Z'],
      ['boris', 'Цена зависит от задачи, давайте обсудим на звонке.', '2026-10-01T11:00:00Z'],
    ])
    expect(await buildScenarios(db, { limit: 5 })).toBe(0)
    // The openers that are no names do not hold a scenario back.
    await chat('c2', [
      ['sara_v1', 'Добрый день! Увидели ваш заказ.', '2026-10-02T10:00:00Z'],
      ['client', 'Здравствуйте, подскажите, сколько стоит сайт?', '2026-10-02T10:30:00Z'],
      ['boris', 'Борис, понимаю, цена зависит от задачи, давайте обсудим.', '2026-10-02T11:00:00Z'],
    ])
    expect(await buildScenarios(db, { limit: 5 })).toBe(1)
  })

  it('FR-TRAIN-8: a bare «телефон» is not a request for a call', async () => {
    await chat('c1', [
      ['sara_v1', 'Добрый день! Увидели ваш заказ.', '2026-10-01T10:00:00Z'],
      ['client', 'Подскажите, какой у вас телефон на сайте указан?', '2026-10-01T10:30:00Z'],
      ['boris', 'Телефон есть в шапке сайта, посмотрите там, пожалуйста.', '2026-10-01T11:00:00Z'],
    ])
    await chat('c2', [
      ['sara_v1', 'Добрый день! Увидели ваш заказ.', '2026-10-02T10:00:00Z'],
      ['client', 'Давайте созвонимся завтра?', '2026-10-02T10:30:00Z'],
      ['boris', 'Да, давайте, напишу вам время чуть позже.', '2026-10-02T11:00:00Z'],
    ])
    await buildScenarios(db, { limit: 5 })
    const built = (await proposals()).map((r) => ExamScenario.parse(JSON.parse(r.content)))
    const byText = (re: RegExp) => built.find((b) => re.test(b.messages.at(-1)?.text ?? ''))
    expect(byText(/телефон/)?.expect).toMatchObject({ move: 'reply' })
    expect(byText(/созвонимся/)?.expect).toMatchObject({ move: 'call_boris', topic: 'call' })
  })

  it('FR-TRAIN-8: nothing is written but the proposal, and the journal knows of it by number', async () => {
    await chat('c1', [
      ['sara_v1', BID, '2026-10-01T10:00:00Z'],
      ['client', 'Как будем работать?', '2026-10-01T10:30:00Z'],
      ['boris', 'Начнём с короткого созвона, расскажу как идёт работа.', '2026-10-01T11:00:00Z'],
    ])
    await buildScenarios(db, { limit: 5 })
    const events = await db.select().from(event).where(eq(event.type, 'mind.proposed'))
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ kind: 'scenario' })
  })

  it('FR-TRAIN-8: a second build does not propose the same turns again, and numbers go on', async () => {
    await chat('c1', [
      ['sara_v1', BID, '2026-10-01T10:00:00Z'],
      ['client', 'Как будем работать?', '2026-10-01T10:30:00Z'],
      ['boris', 'Начнём с короткого созвона, расскажу как идёт работа.', '2026-10-01T11:00:00Z'],
    ])
    expect(await buildScenarios(db, { limit: 10 })).toBe(1)
    expect(await buildScenarios(db, { limit: 10 })).toBe(0)
    await chat('c2', [
      ['sara_v1', BID, '2026-10-02T10:00:00Z'],
      ['client', 'А сколько по срокам?', '2026-10-02T10:30:00Z'],
      ['boris', 'Сроки зависят от задачи, давайте обсудим на звонке.', '2026-10-02T11:00:00Z'],
    ])
    expect(await buildScenarios(db, { limit: 10 })).toBe(1)
    expect((await proposals()).map((r) => r.path)).toEqual([
      'exam/scenarios/x-h-1.json',
      'exam/scenarios/x-h-2.json',
    ])
  })

  it('FR-TRAIN-8: only answers of Boris with proof are taken, not old Sara and not an unknown voice', async () => {
    await chat('c1', [
      ['sara_v1', BID, '2026-10-01T10:00:00Z'],
      ['client', 'Как будем работать?', '2026-10-01T10:30:00Z'],
      ['sara_v1', 'Начнём с короткого созвона, расскажу как идёт работа.', '2026-10-01T11:00:00Z'],
    ])
    await chat('c2', [
      ['sara_v1', BID, '2026-10-02T10:00:00Z'],
      ['client', 'А сколько по срокам?', '2026-10-02T10:30:00Z'],
      ['unknown', 'Сроки зависят от задачи, давайте обсудим.', '2026-10-02T11:00:00Z'],
    ])
    expect(await buildScenarios(db, { limit: 10 })).toBe(0)
    expect(await proposals()).toEqual([])
  })

  it('FR-TRAIN-8: several client messages before the answer are one turn', async () => {
    await chat('c1', [
      ['sara_v1', BID, '2026-10-01T10:00:00Z'],
      ['client', 'Здравствуйте.', '2026-10-01T10:30:00Z'],
      ['client', 'Расскажите, как вы работаете?', '2026-10-01T10:31:00Z'],
      ['boris', 'Начнём с короткого созвона, расскажу как идёт работа.', '2026-10-01T11:00:00Z'],
    ])
    await buildScenarios(db, { limit: 10 })
    const s = ExamScenario.parse(JSON.parse((await proposals())[0]?.content ?? ''))
    expect(s.messages.map((m) => m.author)).toEqual(['sara_v1', 'client', 'client'])
  })

  it('FR-TRAIN-8: the turns are spread over the kinds of question, not the newest ones only', async () => {
    const ask = async (id: string, q: string, day: string) =>
      chat(id, [
        ['sara_v1', BID, `2026-10-${day}T10:00:00Z`],
        ['client', q, `2026-10-${day}T10:30:00Z`],
        [
          'boris',
          'Давайте обсудим это на коротком звонке, там всё расскажу.',
          `2026-10-${day}T11:00:00Z`,
        ],
      ])
    // Three price questions, the newest, and one question of each other kind.
    await ask('p1', 'Сколько стоит сайт?', '20')
    await ask('p2', 'Какая цена у рекламы?', '19')
    await ask('p3', 'Цена за ведение соцсетей какая?', '18')
    await ask('t1', 'За какой срок сделаете?', '10')
    await ask('o1', 'Как будем работать?', '09')
    expect(await buildScenarios(db, { limit: 3 })).toBe(3)
    const scenarios = (await proposals()).map((r) => ExamScenario.parse(JSON.parse(r.content)))
    const topics = scenarios.map((s) => s.expect.topic ?? 'open')
    // One price question, and the two kinds that are not price: not three prices.
    expect(topics.filter((t) => t === 'price')).toHaveLength(1)
  })

  it('FR-TRAIN-8: a turn with nothing to say or a reply too short to learn from is left out', async () => {
    await chat('c1', [
      ['sara_v1', BID, '2026-10-01T10:00:00Z'],
      ['client', 'Ок', '2026-10-01T10:30:00Z'],
      ['boris', 'Да', '2026-10-01T11:00:00Z'],
    ])
    expect(await buildScenarios(db, { limit: 10 })).toBe(0)
  })

  it('FR-TRAIN-8: the limit is respected', async () => {
    for (const [i, q] of [
      'Как будем работать?',
      'За какой срок сделаете?',
      'Кто будет делать?',
    ].entries())
      await chat(`c${i}`, [
        ['sara_v1', BID, `2026-10-0${i + 1}T10:00:00Z`],
        ['client', q, `2026-10-0${i + 1}T10:30:00Z`],
        [
          'boris',
          'Давайте обсудим это на коротком звонке, там всё расскажу.',
          `2026-10-0${i + 1}T11:00:00Z`,
        ],
      ])
    expect(await buildScenarios(db, { limit: 2 })).toBe(2)
    expect(await proposals()).toHaveLength(2)
  })
})
