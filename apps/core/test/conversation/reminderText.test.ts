import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeReminder } from '../../src/conversation/reminderText'
import { fakeMind } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { type FakeGateway, fakeGateway } from '../helpers/gateway'
import { seedChat } from '../helpers/reminders'

vi.setConfig({ testTimeout: 30_000 })

const { db, close } = openTestDb()
afterAll(close)

const CHAT = '95147898'
const NAME = 'Снежана'
const GOOD = {
  text: '[имя 1], здравствуйте! Как у вас дела с сайтом для клиники? Удобно вернуться к нему на этой неделе?',
  fact_ids: ['s-portrait', 'k-process-start'],
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

async function write(
  fake: FakeGateway,
  o: { read?: boolean; tone?: 'check_in' | 'friendly'; step?: 1 | 2 | 3 } = {},
) {
  const conv = await chat()
  return writeReminder(
    { db, gateway: fake.gateway, mind: fakeMind() },
    {
      conversationId: conv.id,
      step: o.step ?? 1,
      tone: o.tone ?? 'check_in',
      read: o.read ?? false,
      now: new Date('2026-10-21T12:00:00.000Z'),
    },
  )
}

describe('the text of a reminder', () => {
  it('FR-CONV-12: the reminder role writes it, the client name reaches the model as a tag and comes back', async () => {
    const fake = await fakeGateway(db, { reminder: GOOD })
    const r = await write(fake)
    expect(r.text).toBe(
      `${NAME}, здравствуйте! Как у вас дела с сайтом для клиники? Удобно вернуться к нему на этой неделе?`,
    )
    expect(r.factIds).toEqual(['s-portrait', 'k-process-start'])
    expect(r.issues).toEqual([])
    const calls = await fake.calls()
    expect(calls.map((c) => c.role)).toEqual(['reminder'])
    expect(calls[0]?.stdin).not.toContain(NAME)
    expect(calls[0]?.stdin).toContain('[имя 1]')
    expect(r.modelCallIds).toHaveLength(1)
  })

  it('FR-CONV-12: read and unread clients get different texts', async () => {
    const fake = await fakeGateway(db, { reminder: GOOD })
    await write(fake, { read: true })
    await write(fake, { read: false })
    const [read, unread] = (await fake.calls()).map((c) => c.stdin)
    expect(read).toContain('Клиент прочитал наше сообщение: да')
    expect(unread).toContain('Клиент прочитал наше сообщение: неизвестно')
    expect(unread).not.toContain('Клиент прочитал наше сообщение: да')
  })

  it('FR-CONV-12: the input names the step, the tone, our last message and the whole chat', async () => {
    const fake = await fakeGateway(db, { reminder: GOOD })
    await write(fake, { step: 3, tone: 'friendly' })
    const stdin = (await fake.calls())[0]?.stdin ?? ''
    for (const heading of [
      '## Заказ',
      '## Клиент',
      '## Переписка',
      '## Наше последнее сообщение',
      '## Напоминание',
      '## Записи разума',
    ])
      expect(stdin, heading).toContain(heading)
    expect(stdin).toContain('Тон: дружеский')
    expect(stdin).toContain('По счёту: 3 из 3')
    expect(stdin).toContain('Хорошо, на связи. Если появятся вопросы, пишите.')
    expect(stdin).toContain('<<< данные клиента\nСпасибо, посмотрю\n>>>')
  })

  it('FR-CONV-12: a dash in the text is written again once, with the reasons', async () => {
    const fake = await fakeGateway(db, {
      reminder: { $sequence: [{ ...GOOD, text: '[имя 1], здравствуйте \u2014 как дела?' }, GOOD] },
    })
    const r = await write(fake)
    expect(r.text).toContain('Как у вас дела')
    expect(r.attempts).toBe(2)
    const [first, second] = (await fake.calls()).map((c) => c.stdin)
    expect(first).not.toContain('## Переделать')
    expect(second).toContain('## Переделать')
    expect(second).toContain('тире')
  })

  it('FR-CONV-12: a text that fails the checks twice is no text', async () => {
    const bad = { ...GOOD, text: '[имя 1], здравствуйте \u2014 как дела?' }
    const fake = await fakeGateway(db, { reminder: bad })
    const r = await write(fake)
    expect(r.text).toBeNull()
    expect(r.issues.map((x) => x.id)).toContain('dash')
    expect(r.attempts).toBe(2)
  })

  it('FR-CONV-12: a number outside the mind, a promise to call and a story of a project all fail', async () => {
    for (const [text, id] of [
      ['[имя 1], здравствуйте! Сделаем сайт за 5 дней, напишите.', 'facts.numbers'],
      ['[имя 1], здравствуйте! Я вам перезвоню завтра, удобно?', 'promise.call'],
      [
        '[имя 1], здравствуйте! У нас был похожий проект для клиники, давайте вернёмся к сайту.',
        'case.unknown',
      ],
    ] as const) {
      await resetDb(db)
      const r = await write(await fakeGateway(db, { reminder: { ...GOOD, text } }))
      expect(r.text, text).toBeNull()
      expect(
        r.issues.map((x) => x.id),
        text,
      ).toContain(id)
    }
  })

  it('FR-CONV-12: a text with no greeting fails, a reminder is always a new day', async () => {
    const r = await write(
      await fakeGateway(db, { reminder: { ...GOOD, text: 'Как у вас дела с сайтом?' } }),
    )
    expect(r.text).toBeNull()
    expect(r.issues.map((x) => x.id)).toContain('greeting.missing')
  })

  it('FR-CONV-12: a model that fails gives no text and says why', async () => {
    const fake = await fakeGateway(db, { reminder: GOOD }, { FAKE_CLAUDE_MODE: 'exit1' })
    const r = await write(fake)
    expect(r.text).toBeNull()
    expect(r.failure).toBe('cli_failed')
    expect(r.issues).toEqual([])
  })

  it('FR-CONV-12: a model that answers off the schema gives no text', async () => {
    const fake = await fakeGateway(db, { reminder: { text: '' } })
    const r = await write(fake)
    expect(r.text).toBeNull()
    expect(r.failure).toBe('bad_output')
  })
})
