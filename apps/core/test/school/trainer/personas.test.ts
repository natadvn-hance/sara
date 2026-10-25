import { type ExamScenario, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { chatMessage, lead, persona, trainingSession } from '../../../src/db/schema'
import {
  buildPersonas,
  handmadePersonas,
  personasJob,
  pickPersona,
} from '../../../src/school/trainer/personas'
import { setSetting } from '../../../src/settings/store'
import { openTestDb, resetDb } from '../../helpers/db'
import { fakeGateway } from '../../helpers/gateway'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  await setSetting(db, 'school.on', true, 'boris')
})

const NOW = new Date('2026-10-26T02:45:00+03:00')
const DAY = 86_400_000

/** A chat with a client's words; chat i is newer than chat i-1, so the newest is numbered 1 for the builder. */
async function chat(
  i: number,
  text = `Нужен сайт для пекарни номер ${i}, сколько это стоит?`,
  name = 'Ольга',
) {
  const orderId = `order-${i}`
  await db.insert(lead).values({
    id: orderId,
    accountId: 'hance',
    title: 'Сайт',
    category: 'Сайты',
    city: 'Краснодар',
    text: 'Сайт для пекарни',
    clientName: name,
    bidPriceRub: 100,
    seenAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
    correlationId: newEventId(),
  })
  await db.insert(chatMessage).values({
    id: newEventId(),
    accountId: 'hance',
    chatId: `chat-${i}`,
    orderId,
    platformMessageId: `m-${i}`,
    side: 'client',
    author: 'client',
    authorBasis: 'side',
    text,
    sentAt: new Date(NOW.getTime() - (100 - i) * 3_600_000).toISOString(),
    source: 'node',
  })
}

const personaOut = (from: number[], over: Record<string, unknown> = {}) => ({
  archetype: 'Владелец малого бизнеса',
  niche: 'Пекарни',
  task: 'Хочет недорогой сайт с меню',
  mood: 'doubt',
  style: 'Коротко, на «вы», без смайлов',
  questions: ['Сколько стоит?', 'Как быстро сделаете?'],
  topics: ['price', 'timeline'],
  order: { title: 'Сайт для кафе', text: 'Нужен сайт с меню и доставкой', budget_text: null },
  difficulty: 2,
  hard: false,
  from,
  ...over,
})

const scenario = (id: string, hard: boolean): ExamScenario => ({
  id,
  title: 'Торгуется о цене',
  source: { kind: 'handmade', ref: null },
  tags: { question_type: null, stage: 'talking', tone: 'bargaining', archetype: 'Торгуется', hard },
  golden: false,
  order: {
    title: 'Настройка рекламы',
    category: 'Реклама',
    text: 'Нужна реклама в Директе',
    budget_text: null,
    city: 'Москва',
  },
  client_name: null,
  bid: null,
  messages: [{ author: 'client', text: 'А дешевле можно?', at: '2026-10-20T10:00:00.000Z' }],
  state: { owner: 'sara', owner_reason: null, boris_note: null },
  now: '2026-10-20T10:01:00.000Z',
  expect: {
    move: 'reply',
    topic: 'discount',
    must_not_contain: [],
    must_mention_any: [],
    boris_reply: null,
  },
  rubric: null,
})

const rows = () => db.select().from(persona)

describe('trainer personas', () => {
  it('FR-TRAIN-2: every persona names its source chats', async () => {
    for (let i = 1; i <= 12; i++) await chat(i)
    const gw = await fakeGateway(db, {
      'persona-builder': { personas: [personaOut([1, 2]), personaOut([3, 4, 5])] },
    })
    expect(await buildPersonas({ db, gateway: gw.gateway }, NOW)).toBe('done')
    const ps = await rows()
    expect(ps.map((p) => p.sourceRefs).sort()).toEqual([
      ['chat-10', 'chat-9', 'chat-8'],
      ['chat-12', 'chat-11'],
    ])
    expect(ps.every((p) => p.active && !p.handmade && /^p-[a-z0-9-]+$/.test(p.id))).toBe(true)
    const call = (await gw.calls())[0]
    expect(call?.role).toBe('persona-builder')
    expect(call?.stdin).toContain('Разговор 1')
    expect(call?.stdin).toContain('Разговор 12')
  })

  it("FR-TRAIN-2: a persona that copies a client's words, one client or a contact is refused", async () => {
    for (let i = 1; i <= 12; i++) await chat(i)
    const gw = await fakeGateway(db, {
      'persona-builder': {
        personas: [
          // Six words in a row from chat-12 (number 1).
          personaOut([1, 2], { task: 'Нужен сайт для пекарни номер 12' }),
          // Only one real chat behind it.
          personaOut([3, 99]),
          personaOut([4, 5], { style: 'Пишет с почты olga@bakery.ru' }),
          personaOut([6, 7], { task: 'Заказ 1234567 повторить' }),
          personaOut([8, 9], { archetype: '[имя 1] из пекарни' }),
          personaOut([10, 11]),
        ],
      },
    })
    await buildPersonas({ db, gateway: gw.gateway }, NOW)
    const ps = await rows()
    expect(ps.map((p) => p.sourceRefs)).toEqual([['chat-3', 'chat-2']])
  })

  it('NFR-PRIV-2: the persona builder never sees a client name or phone', async () => {
    await chat(1, 'Меня зовут Ольга, мой телефон +7 916 123-45-67, пишите на olga@bakery.ru')
    for (let i = 2; i <= 12; i++) await chat(i)
    const gw = await fakeGateway(db, { 'persona-builder': { personas: [personaOut([1, 2])] } })
    await buildPersonas({ db, gateway: gw.gateway }, NOW)
    const stdin = (await gw.calls())[0]?.stdin ?? ''
    expect(stdin).toContain('Меня зовут')
    expect(stdin).not.toContain('Ольга')
    expect(stdin).not.toContain('916')
    expect(stdin).not.toContain('bakery')
  })

  it('FR-TRAIN-2: with little history the handmade personas are used and marked', async () => {
    for (let i = 1; i <= 3; i++) await chat(i)
    const gw = await fakeGateway(db, { 'persona-builder': { personas: [] } })
    const r = await buildPersonas({ db, gateway: gw.gateway }, NOW, {
      handmade: async () => [scenario('x-price-1', true), scenario('x-price-2', false)],
    })
    expect(r).toBe('done')
    expect(await gw.calls()).toHaveLength(0)
    const ps = await rows()
    expect(ps.map((p) => [p.id, p.handmade, p.sourceRefs]).sort()).toEqual([
      ['p-h-price-1', true, ['handmade:x-price-1']],
      ['p-h-price-2', true, ['handmade:x-price-2']],
    ])
    expect(handmadePersonas([scenario('x-a', true)])[0]).toMatchObject({
      archetype: 'Торгуется',
      mood: 'bargaining',
      hard: true,
      topics: ['discount'],
      questions: ['А дешевле можно?'],
      order: { title: 'Настройка рекламы', text: 'Нужна реклама в Директе', budget_text: null },
    })
  })

  it('FR-TRAIN-2: new personas switch off the handmade ones and those older than 60 days', async () => {
    for (let i = 1; i <= 12; i++) await chat(i)
    const old = { ...handmadePersonas([scenario('x-old', false)])[0] }
    await db.insert(persona).values([
      {
        id: 'p-h-old',
        archetype: old.archetype ?? '',
        niche: old.niche ?? '',
        task: old.task ?? '',
        mood: 'neutral',
        order: old.order,
        difficulty: 1,
        sourceRefs: ['handmade:x-old'],
        handmade: true,
      },
      {
        id: 'p-old',
        archetype: 'Старый',
        niche: 'Старое',
        task: 'Старое',
        mood: 'neutral',
        order: old.order,
        difficulty: 1,
        sourceRefs: ['chat-1', 'chat-2'],
        builtAt: new Date(NOW.getTime() - 70 * DAY).toISOString(),
      },
      {
        id: 'p-recent',
        archetype: 'Недавний',
        niche: 'Недавнее',
        task: 'Недавнее',
        mood: 'neutral',
        order: old.order,
        difficulty: 1,
        sourceRefs: ['chat-1', 'chat-2'],
        builtAt: new Date(NOW.getTime() - 20 * DAY).toISOString(),
      },
    ])
    const gw = await fakeGateway(db, { 'persona-builder': { personas: [personaOut([1, 2])] } })
    await buildPersonas({ db, gateway: gw.gateway }, NOW)
    const active = (await rows()).filter((p) => p.active).map((p) => p.id)
    expect(active).toContain('p-recent')
    expect(active).not.toContain('p-old')
    expect(active).not.toContain('p-h-old')
    expect(active).toHaveLength(2)
  })

  it('FR-TRAIN-2: the night job builds once a week or after 20 new conversations', async () => {
    for (let i = 1; i <= 12; i++) await chat(i)
    const gw = await fakeGateway(db, {
      'persona-builder': { personas: [personaOut([1, 2])] },
    })
    const d = { db, gateway: gw.gateway } as never
    expect(await personasJob.estimate(d, NOW)).toBe(4)
    expect(await personasJob.run(d, NOW)).toBe('done')
    const later = new Date(NOW.getTime() + 2 * DAY)
    expect(await personasJob.estimate(d, later)).toBe(0)
    expect(await personasJob.run(d, later)).toBe('nothing')
    for (let i = 13; i <= 32; i++) await chat(i)
    await db
      .update(chatMessage)
      .set({ sentAt: new Date(later.getTime() - 3_600_000).toISOString() })
      .where(eq(chatMessage.source, 'node'))
    expect(await personasJob.estimate(d, later)).toBe(4)
    expect(await personasJob.estimate(d, new Date(NOW.getTime() + 8 * DAY))).toBe(4)
    expect(personasJob).toMatchObject({ name: 'personas', models: ['sonnet'] })
  })

  it('FR-TRAIN-3: the trainer picks a persona by topics and hardness, the least used first', async () => {
    expect(await pickPersona(db, { preferTopics: ['price'], hard: false })).toBeNull()
    const [a, b] = handmadePersonas([scenario('x-hard', true), scenario('x-easy', false)])
    for (const p of [a, b])
      if (p)
        await db.insert(persona).values({
          id: p.id,
          archetype: p.archetype,
          niche: p.niche,
          task: p.task,
          mood: p.mood,
          topics: p.topics,
          order: p.order,
          difficulty: p.difficulty,
          hard: p.hard,
          sourceRefs: p.source_refs,
          handmade: true,
        })
    expect((await pickPersona(db, { preferTopics: ['discount'], hard: true }))?.id).toBe('p-h-hard')
    expect((await pickPersona(db, { preferTopics: ['discount'], hard: false }))?.id).toBe(
      'p-h-easy',
    )
    await db.insert(trainingSession).values([
      { id: newEventId(), mode: 'client', personaId: 'p-h-easy', startedAt: NOW.toISOString() },
      { id: newEventId(), mode: 'client', personaId: 'p-h-easy', startedAt: NOW.toISOString() },
    ])
    const p = await pickPersona(db, { preferTopics: [], hard: false })
    expect(p?.id).toBe('p-h-hard')
    expect(p?.source_refs).toEqual(['handmade:x-hard'])
  })
})
