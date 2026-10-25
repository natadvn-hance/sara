import { newEventId } from '@sara/shared'
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrateNode } from '../../../profi-node/src/db/migrate'
import { chatMessage, conversation, outbox } from '../../src/db/schema'
import {
  exportHistory,
  formatExportReport,
  v1MessageId as v1Id,
} from '../../src/history/exportHistory'
import type { V1Lead } from '../../src/history/v1Snapshot'
import { listEvents } from '../../src/journal/journal'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'

const { db, close } = openTestDb()
beforeAll(() => migrateNode(testDatabaseUrl()))
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  await db.execute(sql`truncate node.raw_message`)
})

const ACCOUNT = 'hance-marketing'
const startedAt = '2026-09-09T16:14:00.000Z'

const lead = (orderId: string, over: Partial<V1Lead> = {}): V1Lead => ({
  orderId,
  clientName: 'Ирина',
  description: 'Нужен сайт для студии',
  category: 'Сайты',
  city: 'Москва',
  status: 'responded',
  draftResponse: 'Здравствуйте! Сделаем сайт за месяц.',
  draftResponseOriginal: null,
  respondedAt: '2026-09-20T08:00:00.000Z',
  borisWroteText: null,
  borisWroteAt: null,
  takenByBorisAt: null,
  dictatedReply: null,
  proposedReply: null,
  replyApprovedAt: null,
  customerReply: null,
  createdAt: '2026-09-20T07:50:00.000Z',
  updatedAt: '2026-09-21T09:00:00.000Z',
  ...over,
})

let n = 0
const minute = (m: number) =>
  new Date(Date.parse('2026-10-01T10:00:00.000Z') + m * 60_000).toISOString()

async function raw(r: {
  chat: string
  order?: string | null
  author: 'client' | 'specialist' | 'system' | 'unknown'
  text: string
  at?: string
  history?: boolean
  id?: string
}) {
  const id = r.id ?? `m${++n}`
  await db.execute(sql`insert into node.raw_message
    (platform_message_id, chat_id, account_id, order_id, author, sent_at, text, history)
    values (${id}, ${r.chat}, ${ACCOUNT}, ${r.order ?? null}, ${r.author}, ${r.at ?? minute(n)}, ${r.text}, ${r.history ?? false})`)
  return id
}

const run = (
  leads: V1Lead[] | null,
  over: { telegram?: string[]; v1Writes?: boolean; v1StoppedAt?: string | null } = {},
) =>
  exportHistory(db, {
    accountId: ACCOUNT,
    v1: leads ? { leads, startedAt } : null,
    telegramV1Texts: new Set(over.telegram ?? []),
    v1Writes: over.v1Writes ?? true,
    v1StoppedAt: over.v1StoppedAt ?? null,
  })

const stored = () =>
  db
    .select()
    .from(chatMessage)
    .orderBy(asc(chatMessage.chatId), asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))

describe('history export', () => {
  it('FR-TRAIN-1: node messages land in chat_message with side, author and basis', async () => {
    const conv = newEventId()
    await db
      .insert(conversation)
      .values({ id: conv, accountId: ACCOUNT, chatId: 'c1', orderId: '7001' })
    await raw({ chat: 'c1', order: '7001', author: 'system', text: 'Вы откликнулись', id: 'a0' })
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'specialist',
      text: 'Здравствуйте! Сделаем сайт за месяц.',
      id: 'a1',
    })
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'specialist',
      text: 'Стоимость: 40 000 ₽',
      id: 'a2',
    })
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'client',
      text: 'А примеры работ есть?',
      id: 'a3',
    })
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'specialist',
      text: 'Пришлю три кейса вечером',
      id: 'a4',
    })
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'specialist',
      text: 'Посмотрите наш сайт',
      id: 'a5',
    })
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'specialist',
      text: 'Стоимость: 50 000 ₽',
      id: 'a6',
    })
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'specialist',
      text: 'Жду ваших новостей',
      id: 'a7',
    })
    const leads = [lead('7001', { borisWroteText: 'Добрый день.\n\nПришлю три кейса вечером' })]

    await run(leads, { telegram: ['посмотрите наш сайт'] })

    const rows = await stored()
    expect(rows.map((r) => [r.platformMessageId, r.side, r.author, r.authorBasis])).toEqual([
      ['a0', 'system', 'system', 'side'],
      ['a1', 'specialist', 'sara_v1', 'v1_bid'],
      ['a2', 'specialist', 'sara_v1', 'v1_bid'],
      ['a3', 'client', 'client', 'side'],
      ['a4', 'specialist', 'boris', 'v1_boris_text'],
      ['a5', 'specialist', 'sara_v1', 'telegram_export'],
      ['a6', 'specialist', 'unknown', 'v1_or_boris'],
      ['a7', 'specialist', 'unknown', 'v1_or_boris'],
    ])
    expect(rows[0]).toMatchObject({
      accountId: ACCOUNT,
      chatId: 'c1',
      orderId: '7001',
      source: 'node',
      approxTime: false,
      conversationId: conv,
      text: 'Вы откликнулись',
    })
  })

  it('FR-TRAIN-1: a message read in a first reading has an approximate time, never proof before v1', async () => {
    const before = '2026-09-01T10:00:00.000Z'
    await raw({
      chat: 'c2',
      author: 'specialist',
      text: 'Добрый день',
      at: before,
      history: true,
      id: 'h1',
    })
    await raw({ chat: 'c2', author: 'specialist', text: 'Добрый вечер', at: before, id: 'h2' })
    await run([lead('7001')])
    const rows = (await stored()).filter((r) => r.chatId === 'c2')
    expect(rows.map((r) => [r.text, r.approxTime, r.author, r.authorBasis])).toEqual([
      ['Добрый день', true, 'unknown', 'v1_or_boris'],
      ['Добрый вечер', false, 'boris', 'before_v1'],
    ])
  })

  it('FR-TRAIN-1: the bid and messages the new Sara sent are hers', async () => {
    await db.insert(outbox).values([
      {
        id: newEventId(),
        kind: 'bid',
        idempotencyKey: 'bid:7003',
        payload: { leadId: '7003', accountId: ACCOUNT, text: 'Здравствуйте! Новый отклик.' },
        state: 'confirmed',
      },
      {
        id: newEventId(),
        kind: 'message',
        idempotencyKey: 'msg:t1:1',
        payload: { chatId: 'c3', accountId: ACCOUNT, text: 'Удобно завтра в 11?', author: 'sara' },
        state: 'confirmed',
        confirmedAt: minute(10),
      },
    ])
    const bid = 'Здравствуйте! Новый отклик.'
    await raw({
      chat: 'c3',
      order: '7003',
      author: 'specialist',
      text: bid,
      at: minute(1),
      history: true,
    })
    await raw({
      chat: 'c3',
      order: '7003',
      author: 'client',
      text: 'Давайте созвонимся',
      at: minute(5),
    })
    await raw({
      chat: 'c3',
      order: '7003',
      author: 'specialist',
      text: 'Удобно завтра в 11?',
      at: minute(11),
    })
    await run(null)
    expect((await stored()).map((r) => [r.author, r.authorBasis])).toEqual([
      ['sara', 'outbox'],
      ['client', 'side'],
      ['sara', 'outbox'],
    ])
  })

  it('FR-TRAIN-1: a repeated export adds nothing', async () => {
    await raw({ chat: 'c1', order: '7001', author: 'client', text: 'Здравствуйте' })
    await raw({ chat: 'c1', order: '7001', author: 'specialist', text: 'Добрый день' })
    const leads = [lead('7001'), lead('7002', { customerReply: 'Сколько стоит?' })]
    await run(leads)
    const first = await stored()
    const again = await run(leads)
    expect(await stored()).toEqual(first)
    expect(again.chats).toBe(2)
  })

  it('FR-TRAIN-1: a chat the node never read gets v1-only messages with approx_time', async () => {
    await run([
      lead('7002', {
        borisWroteText: 'Добрый день.\n\nПосчитаю и вернусь завтра',
        borisWroteAt: '2026-09-22T12:00:00.000Z',
        customerReply: 'А сколько это будет стоить?',
      }),
      lead('7004', { draftResponse: null, respondedAt: null, status: 'skipped' }),
    ])
    const rows = await stored()
    expect(
      rows.map((r) => [
        r.platformMessageId,
        r.chatId,
        r.side,
        r.author,
        r.authorBasis,
        r.source,
        r.approxTime,
      ]),
    ).toEqual([
      [
        v1Id('7002', 'bid', 'Здравствуйте! Сделаем сайт за месяц.'),
        'v1:7002',
        'specialist',
        'sara_v1',
        'v1_bid',
        'v1',
        true,
      ],
      [
        v1Id('7002', 'client', 'А сколько это будет стоить?'),
        'v1:7002',
        'client',
        'client',
        'side',
        'v1',
        true,
      ],
      [
        v1Id('7002', 'boris', 'Добрый день.'),
        'v1:7002',
        'specialist',
        'boris',
        'v1_boris_text',
        'v1',
        true,
      ],
      [
        v1Id('7002', 'boris', 'Посчитаю и вернусь завтра'),
        'v1:7002',
        'specialist',
        'boris',
        'v1_boris_text',
        'v1',
        true,
      ],
    ])
    expect(rows.map((r) => r.text)).toEqual([
      'Здравствуйте! Сделаем сайт за месяц.',
      'А сколько это будет стоить?',
      'Добрый день.',
      'Посчитаю и вернусь завтра',
    ])
    expect(new Date(rows[0]?.sentAt ?? '').toISOString()).toBe('2026-09-20T08:00:00.000Z')
  })

  it('FR-TRAIN-1: a real message replaces the v1-only copy with the same text', async () => {
    const leads = [
      lead('7002', {
        borisWroteText: 'Добрый день.\n\nПосчитаю и вернусь завтра',
        customerReply: 'А сколько это будет стоить?',
      }),
    ]
    await run(leads)
    await raw({
      chat: 'c7',
      order: '7002',
      author: 'client',
      text: 'А сколько это будет  стоить?',
      id: 'r1',
    })
    await raw({
      chat: 'c7',
      order: '7002',
      author: 'specialist',
      text: 'Посчитаю и вернусь завтра.',
      id: 'r2',
    })
    const report = await run(leads)
    const rows = await stored()
    expect(rows.map((r) => [r.platformMessageId, r.chatId, r.source])).toEqual([
      [v1Id('7002', 'bid', 'Здравствуйте! Сделаем сайт за месяц.'), 'c7', 'v1'],
      [v1Id('7002', 'boris', 'Добрый день.'), 'c7', 'v1'],
      ['r1', 'c7', 'node'],
      ['r2', 'c7', 'node'],
    ])
    expect(report).toMatchObject({ chats: 1, v1Only: 2 })
  })

  it("FR-TRAIN-1: the report line counts Boris's messages", async () => {
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'specialist',
      text: 'Добрый вечер',
      at: '2026-09-01T10:00:00.000Z',
    })
    await raw({ chat: 'c1', order: '7001', author: 'client', text: 'Здравствуйте' })
    await raw({ chat: 'c1', order: '7001', author: 'specialist', text: 'Подскажите бюджет?' })
    const one = await run([lead('7001')])
    expect(one).toMatchObject({
      chats: 1,
      borisMessages: 1,
      unknownSpecialist: 1,
      v1Only: 0,
      line: 'Нашла 1 диалог, 1 твоё сообщение',
    })
    expect(one.messages).toEqual({
      client: 1,
      boris: 1,
      sara: 0,
      sara_v1: 0,
      system: 0,
      unknown: 1,
    })

    const more = await run([
      lead('7001'),
      lead('7002', { borisWroteText: 'Раз\n\nДва\n\nТри\n\nЧетыре' }),
      lead('7005', { borisWroteText: 'Пять' }),
    ])
    expect(more.line).toBe('Нашла 3 диалога, 6 твоих сообщений')
  })

  it('FR-TRAIN-1: the export is journaled with numbers only', async () => {
    await raw({ chat: 'c1', order: '7001', author: 'client', text: 'Секретный текст клиента' })
    await run([lead('7001', { borisWroteText: 'Слова Бориса' })])
    const [e] = await listEvents(db, { type: 'history.exported' })
    expect(e).toMatchObject({ account_id: ACCOUNT, entity: { kind: 'account', id: ACCOUNT } })
    const payload = JSON.stringify(e?.payload)
    expect(payload).not.toMatch(/Секретный|Бориса|Ирина|Здравствуйте/)
    expect(e?.payload).toMatchObject({ chats: 1, added: 1 })
  })

  it("FR-CONV-10: the export after the switch takes for Boris's only what was sent after it", async () => {
    await raw({
      chat: 'c1',
      author: 'specialist',
      text: 'Раньше',
      at: '2026-10-01T10:00:00.000Z',
      id: 'b1',
    })
    await raw({
      chat: 'c1',
      author: 'specialist',
      text: 'Позже',
      at: '2026-11-02T10:00:00.000Z',
      id: 'b2',
    })
    await raw({
      chat: 'c1',
      author: 'specialist',
      text: 'Из истории',
      at: '2026-11-02T10:01:00.000Z',
      id: 'b3',
      history: true,
    })
    await run(null, { v1Writes: false, v1StoppedAt: '2026-11-01T00:00:00.000Z' })
    const rows = await stored()
    expect(rows.map((r) => [r.platformMessageId, r.author])).toEqual([
      ['b1', 'unknown'],
      ['b2', 'boris'],
      ['b3', 'unknown'],
    ])
  })

  it('FR-TRAIN-1: the export proves a message the live sync stored as nobody’s, and joins it to its conversation', async () => {
    const conv = newEventId()
    await db
      .insert(conversation)
      .values({ id: conv, accountId: ACCOUNT, chatId: 'c1', orderId: '7001' })
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'specialist',
      text: 'Здравствуйте! Сделаем сайт за месяц.',
      id: 'l1',
    })
    // The live sync (part C) stored it first, before the conversation was joined, with no proof.
    await db.insert(chatMessage).values({
      id: newEventId(),
      accountId: ACCOUNT,
      chatId: 'c1',
      orderId: '7001',
      platformMessageId: 'l1',
      side: 'specialist',
      author: 'unknown',
      authorBasis: 'v1_or_boris',
      text: 'Здравствуйте! Сделаем сайт за месяц.',
      sentAt: minute(1),
      source: 'node',
    })
    await run([lead('7001')])
    const [row] = await db.select().from(chatMessage).where(eq(chatMessage.platformMessageId, 'l1'))
    expect(row).toMatchObject({ author: 'sara_v1', authorBasis: 'v1_bid', conversationId: conv })
  })

  it('FR-TRAIN-1: a stronger author stays; a live «sara» row of Boris’s dictated text becomes his', async () => {
    await db.insert(outbox).values({
      id: newEventId(),
      kind: 'message',
      idempotencyKey: 'msg:say:1',
      state: 'confirmed',
      confirmedAt: minute(1),
      payload: { accountId: ACCOUNT, chatId: 'c1', text: 'Мой текст клиенту', author: 'boris' },
    })
    await raw({
      chat: 'c1',
      order: '7001',
      author: 'specialist',
      text: 'Мой текст клиенту',
      at: minute(1),
      id: 'd1',
    })
    await db.insert(chatMessage).values({
      id: newEventId(),
      accountId: ACCOUNT,
      chatId: 'c1',
      orderId: '7001',
      platformMessageId: 'd1',
      side: 'specialist',
      author: 'sara',
      authorBasis: 'outbox',
      text: 'Мой текст клиенту',
      sentAt: minute(1),
      source: 'node',
    })
    await run(null)
    const [row] = await db.select().from(chatMessage).where(eq(chatMessage.platformMessageId, 'd1'))
    expect(row).toMatchObject({ author: 'boris', authorBasis: 'say' })
  })

  it('FR-TRAIN-1: a v1 copy stays when its real message is still nobody’s', async () => {
    const leads = [lead('7002', { borisWroteText: 'Посчитаю и вернусь завтра' })]
    await run(leads)
    await raw({
      chat: 'c7',
      order: '7002',
      author: 'specialist',
      text: 'Посчитаю и вернусь завтра',
      id: 'u1',
    })
    // Without the snapshot the real message has no proof: the copy keeps Boris's words.
    await run(null)
    const rows = await stored()
    expect(rows.filter((r) => r.author === 'boris').map((r) => r.source)).toEqual(['v1'])
  })

  it('FR-TRAIN-1: a newer snapshot with other words keeps both copies', async () => {
    await run([lead('7002', { borisWroteText: 'Раз' })])
    await run([lead('7002', { borisWroteText: 'Два' })])
    const words = (await stored()).filter((r) => r.author === 'boris').map((r) => r.text)
    expect(words.sort()).toEqual(['Два', 'Раз'])
  })

  it('FR-TRAIN-1: v1 copies stay out of the conversation, their times are made up', async () => {
    const conv = newEventId()
    await db
      .insert(conversation)
      .values({ id: conv, accountId: ACCOUNT, chatId: 'c7', orderId: '7002' })
    const leads = [lead('7002', { borisWroteText: 'Посчитаю', customerReply: 'А цена?' })]
    await run(leads)
    await raw({ chat: 'c7', order: '7002', author: 'client', text: 'Добрый день', id: 'k1' })
    await run(leads)
    const rows = await stored()
    expect(rows.filter((r) => r.source === 'v1').every((r) => r.conversationId === null)).toBe(true)
    expect(rows.find((r) => r.platformMessageId === 'k1')?.conversationId).toBe(conv)
  })

  it('FR-TRAIN-1: the cut start of Boris’s words is no copy', async () => {
    const cut = 'ершу завтра, как договорились.'
    const text = `${cut}\n\n${'Подробный ответ. '.repeat(70)}`
    expect(text.length).toBeGreaterThanOrEqual(1000)
    await run([lead('7002', { borisWroteText: text })])
    const words = (await stored()).filter((r) => r.author === 'boris').map((r) => r.text)
    expect(words).toHaveLength(1)
    expect(words[0]).not.toContain(cut)
  })

  it('FR-TRAIN-1: a v1 paragraph that is also old Sara’s approved draft is nobody’s', async () => {
    const both = 'Хорошо, тогда созвонимся в четверг.'
    await run([lead('7002', { borisWroteText: both, proposedReply: both })])
    const rows = (await stored()).filter((r) => r.text === both)
    expect(rows.map((r) => r.author)).toEqual(['unknown'])
  })

  it('FR-TRAIN-1: the report reads in plain words', () => {
    const text = formatExportReport({
      chats: 2,
      messages: { client: 5, boris: 3, sara: 0, sara_v1: 2, system: 1, unknown: 4 },
      unknownSpecialist: 3,
      v1Only: 2,
      borisMessages: 3,
      line: 'Нашла 2 диалога, 3 твоих сообщения',
    })
    expect(text).toBe(
      [
        'Нашла 2 диалога, 3 твоих сообщения',
        'По авторам: клиенты 5, ты 3, новая Сара 0, старая Сара 2, Профи.ру 1, не понять 4.',
        'Без доказательства, чьи они: 3 сообщения со стороны Hance. Пока v1 пишет с того же аккаунта, такие сообщения не считаются твоими.',
        'Только из базы v1, время примерное: 2.',
      ].join('\n'),
    )
  })
})
