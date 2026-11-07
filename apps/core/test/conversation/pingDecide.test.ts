import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hookIssues } from '../../src/conversation/check/hookChecks'
import { decidePing } from '../../src/conversation/pingDecide'
import type { PingScenario } from '../../src/conversation/pingScenario'
import { modelCall } from '../../src/db/schema'
import { setSetting } from '../../src/settings/store'
import { fakeMind } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { type FakeGateway, fakeGateway } from '../helpers/gateway'
import { seedChat } from '../helpers/reminders'

vi.setConfig({ testTimeout: 30_000 })

const { db, close } = openTestDb()
afterAll(close)

const CHAT = '95147898'
const NAME = 'Снежана'
const FACTS = ['s-portrait', 'k-process-start']
const GOOD = {
  decision: 'ping',
  why_now: 'Клиент молчит с отклика, сообщение не прочитано',
  text: '[имя 1], добрый день! Как у вас дела с сайтом для клиники? Удобно вернуться к нему на этой неделе?',
  hook: null,
  fact_ids: FACTS,
}
const PAGE = 'https://www.example.ru/news/clinics-2026?utm_source=x'
const WITH_FACT = {
  ...GOOD,
  text: '[имя 1], добрый день! По данным отрасли, записей онлайн в клиниках стало на 12% больше. Как у вас с сайтом?',
  hook: { fact: 'Онлайн записей в частные клиники стало на 12% больше', source_url: PAGE },
}
const NOW = new Date('2026-10-21T12:00:00.000Z')
const DAY = 24 * 3600_000
const SINCE_BID: PingScenario = {
  kind: 'since_bid',
  quote: null,
  item: null,
  day: null,
  nextStep: null,
}

beforeEach(async () => {
  await resetDb(db)
})

const chat = () =>
  seedChat(
    db,
    CHAT,
    [
      {
        id: 'm-1',
        side: 'specialist',
        text: `${NAME}, добрый день! Понимаю задачу, сделаем сайт.`,
        at: '2026-10-20T10:00:00.000Z',
      },
      { id: 'm-2', side: 'client', text: 'Спасибо, посмотрю', at: '2026-10-20T10:05:00.000Z' },
      {
        id: 'm-3',
        side: 'specialist',
        text: 'Хорошо, на связи. Если появятся вопросы, пишите.',
        at: '2026-10-20T10:06:00.000Z',
      },
    ],
    { clientName: NAME },
  )

async function decide(
  fake: FakeGateway,
  o: {
    read?: boolean
    step?: number
    scenario?: PingScenario
    laterUntil?: Date | null
  } = {},
) {
  const conv = await chat()
  return decidePing(
    { db, gateway: fake.gateway, mind: fakeMind() },
    {
      conversationId: conv.id,
      scenario: o.scenario ?? SINCE_BID,
      step: o.step ?? 1,
      read: o.read ?? false,
      now: NOW,
      laterUntil: o.laterUntil === undefined ? new Date(NOW.getTime() + 2 * DAY) : o.laterUntil,
    },
  )
}

describe('the Pinger decides (spec 2026-11-07-organic-pings)', () => {
  it('FR-CONV-12: a ping: the name reaches the model as a tag and comes back, the card gets why now', async () => {
    const fake = await fakeGateway(db, { pinger: GOOD })
    const r = await decide(fake)
    expect(r.choice).toEqual({
      kind: 'ping',
      text: `${NAME}, добрый день! Как у вас дела с сайтом для клиники? Удобно вернуться к нему на этой неделе?`,
      why: 'Клиент молчит с отклика, сообщение не прочитано',
      source: null,
    })
    expect(r.issues).toEqual([])
    const calls = await fake.calls()
    expect(calls.map((c) => c.role)).toEqual(['pinger'])
    expect(calls[0]?.stdin).not.toContain(NAME)
    expect(calls[0]?.stdin).toContain('[имя 1]')
  })

  it('FR-CONV-12: the input names the scenario, the read mark, the ping number and what may be chosen', async () => {
    const fake = await fakeGateway(db, { pinger: GOOD })
    await decide(fake, {
      read: true,
      step: 3,
      scenario: {
        kind: 'awaiting',
        quote: 'Пришлите ТЗ, посмотрю',
        item: 'tz',
        day: null,
        nextStep: null,
      },
    })
    const stdin = (await fake.calls())[0]?.stdin ?? ''
    for (const heading of [
      '## Заказ',
      '## Клиент',
      '## Переписка',
      '## Наше последнее сообщение',
      '## Ситуация',
      '## Можно',
      '## Записи разума',
    ])
      expect(stdin, heading).toContain(heading)
    expect(stdin).toContain('Сценарий: ждем от клиента конкретное')
    expect(stdin).toContain('Слова, на которых он стоит: «Пришлите ТЗ, посмотрю»')
    expect(stdin).toContain('Ждем от клиента: ТЗ или бриф')
    expect(stdin).toContain('Клиент прочитал наше последнее сообщение: да')
    expect(stdin).toContain('Пинг по счету: 3 из 3, последний')
    expect(stdin).toContain('- later: подождать еще 1-3 дня, но не позже 23.10')
    expect(stdin).toContain('<<< данные клиента\nСпасибо, посмотрю\n>>>')
  })

  it('FR-CONV-12: a fresh fact goes with the page the search really gave; its number is allowed', async () => {
    const fake = await fakeGateway(db, {
      pinger: { ...WITH_FACT, $web: ['https://example.ru/news/clinics-2026'] },
    })
    const r = await decide(fake)
    expect(r.issues).toEqual([])
    expect(r.choice).toMatchObject({ kind: 'ping', source: PAGE })
    expect(r.choice?.kind === 'ping' && r.choice.text).toContain('на 12% больше')
  })

  it('FR-CONV-12: a fact whose page the search never gave is dropped: the rewrite goes without news', async () => {
    const fake = await fakeGateway(db, {
      pinger: { $sequence: [{ ...WITH_FACT, $web: ['https://other.ru/a'] }, GOOD] },
    })
    const r = await decide(fake)
    expect(r.choice).toMatchObject({ kind: 'ping', source: null })
    expect(r.attempts).toBe(2)
    const [first, second] = (await fake.calls()).map((c) => c.stdin)
    expect(first).not.toContain('## Переделать')
    expect(second).toContain('у факта нет страницы, которую поиск правда дал')
    expect(second).toContain('Без новостей и фактов')
  })

  it('FR-CONV-12: news words with no fact, twice, are no text', async () => {
    const bad = {
      ...GOOD,
      text: '[имя 1], добрый день! По данным аналитиков, рынок клиник растет. Как вы?',
    }
    const r = await decide(await fakeGateway(db, { pinger: bad }))
    expect(r.choice).toBeNull()
    expect(r.issues.map((x) => x.id)).toContain('hook.unsourced')
    expect(r.attempts).toBe(2)
  })

  it('FR-CONV-12: a dash, a number outside the mind, a promise to call, no greeting all fail as before', async () => {
    for (const [text, id] of [
      ['[имя 1], добрый день \u2014 как дела с сайтом?', 'dash'],
      ['[имя 1], добрый день! Сделаем сайт за 5 дней, напишите.', 'facts.numbers'],
      ['[имя 1], добрый день! Я вам перезвоню завтра, удобно?', 'promise.call'],
      ['Как у вас дела с сайтом?', 'greeting.missing'],
    ] as const) {
      await resetDb(db)
      const r = await decide(await fakeGateway(db, { pinger: { ...GOOD, text } }))
      expect(r.choice, text).toBeNull()
      expect(
        r.issues.map((x) => x.id),
        text,
      ).toContain(id)
    }
  })

  it('FR-CONV-12: «later» stays inside the window; with the window spent it is asked to decide now', async () => {
    const later = { ...GOOD, decision: 'later', later_days: 3, text: '', why_now: 'выходные' }
    const near = new Date(NOW.getTime() + DAY)
    const r = await decide(await fakeGateway(db, { pinger: later }), { laterUntil: near })
    expect(r.choice).toEqual({ kind: 'later', at: near.toISOString(), why: 'выходные' })
    await resetDb(db)
    const fake = await fakeGateway(db, { pinger: { $sequence: [later, GOOD] } })
    const now = await decide(fake, { laterUntil: null })
    expect(now.choice?.kind).toBe('ping')
    const inputs = (await fake.calls()).map((c) => c.stdin)
    expect(inputs[0]).toContain('- later: нельзя')
    expect(inputs[1]).toContain('ждать больше нельзя')
  })

  it('FR-CONV-12: «boris» is a note for Boris, nothing for the client', async () => {
    const r = await decide(
      await fakeGateway(db, {
        pinger: {
          ...GOOD,
          decision: 'boris',
          text: '',
          why_now: 'Клиент ждет от нас КП',
          boris_note: 'Пришли ему КП, клиенту пока не пишу',
        },
      }),
    )
    expect(r.choice).toEqual({
      kind: 'boris',
      note: 'Пришли ему КП, клиенту пока не пишу',
      why: 'Клиент ждет от нас КП',
    })
  })

  it('FR-CONV-12: our own promise goes to Boris with no model call', async () => {
    const fake = await fakeGateway(db, { pinger: GOOD })
    const r = await decide(fake, {
      scenario: {
        kind: 'our_promise',
        quote: 'Подготовлю предложение и пришлю завтра.',
        item: null,
        day: null,
        nextStep: null,
      },
    })
    expect(r.choice).toMatchObject({
      kind: 'boris',
      note: 'Мы обещали клиенту: «Подготовлю предложение и пришлю завтра.». Он ждет нас.',
    })
    expect(await fake.calls()).toEqual([])
  })

  it('NFR-COST: past the day’s calls the Pinger waits for the morning; 0 calls a day is the ready text', async () => {
    await setSetting(db, 'conv.pings_per_day', 1, 'system')
    await db.insert(modelCall).values({
      id: '00000000-0000-4000-8000-000000000001',
      role: 'pinger',
      roleVersion: 1,
      model: 'sonnet',
      priority: 'P2',
      startedAt: NOW.toISOString(),
      durationMs: 1,
      ok: true,
      pseudonymized: true,
    })
    const fake = await fakeGateway(db, { pinger: GOOD })
    const r = await decide(fake)
    expect(r.choice).toBeNull()
    // 10:00 Moscow of the next day.
    expect(r.capped).toBe('2026-10-22T07:00:00.000Z')
    await resetDb(db)
    await setSetting(db, 'conv.pings_per_day', 0, 'system')
    const off = await decide(fake)
    expect(off).toMatchObject({ choice: null, capped: null, failure: 'off' })
    expect(await fake.calls()).toEqual([])
  })

  it('FR-CONV-12: a model that fails, or answers off the schema, gives no choice and says why', async () => {
    const failed = await decide(
      await fakeGateway(db, { pinger: GOOD }, { FAKE_CLAUDE_MODE: 'exit1' }),
    )
    expect(failed).toMatchObject({ choice: null, failure: 'cli_failed' })
    await resetDb(db)
    const off = await decide(await fakeGateway(db, { pinger: { decision: 'maybe' } }))
    expect(off).toMatchObject({ choice: null, failure: 'bad_output' })
  })
})

describe('the fact checks of a ping', () => {
  const hook = { fact: 'Рынок вырос', source_url: 'https://example.ru/a/' }
  it('a hook passes only with a page the run got; fact words need a hook', () => {
    expect(
      hookIssues({ text: 'Добрый день!', hook, seen: ['https://www.example.ru/a#top'] }),
    ).toEqual([])
    expect(hookIssues({ text: 'Добрый день!', hook, seen: [] }).map((x) => x.id)).toEqual([
      'hook.unsourced',
    ])
    expect(hookIssues({ text: 'Добрый день!', hook, seen: undefined })).toHaveLength(1)
    expect(
      hookIssues({ text: 'Добрый день! Рынок вырос на 10% в 2026 году', hook: null, seen: [] }),
    ).toHaveLength(1)
    // An ordinary check-in is no fact.
    expect(
      hookIssues({ text: 'Добрый день! Есть новости по сайту?', hook: null, seen: [] }),
    ).toEqual([])
  })
})
