import { newEventId } from '@sara/shared'
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { migrateNode } from '../../../profi-node/src/db/migrate'
import { chatMessage, conversation, outbox } from '../../src/db/schema'
import { exportHistory } from '../../src/history/exportHistory'
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

const run = (leads: V1Lead[] | null, over: { telegram?: string[]; v1Writes?: boolean } = {}) =>
  exportHistory(db, {
    accountId: ACCOUNT,
    v1: leads ? { leads, startedAt } : null,
    telegramV1Texts: new Set(over.telegram ?? []),
    v1Writes: over.v1Writes ?? true,
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
      ['v1:7002:bid:0', 'v1:7002', 'specialist', 'sara_v1', 'v1_bid', 'v1', true],
      ['v1:7002:client:0', 'v1:7002', 'client', 'client', 'side', 'v1', true],
      ['v1:7002:boris:0', 'v1:7002', 'specialist', 'boris', 'v1_boris_text', 'v1', true],
      ['v1:7002:boris:1', 'v1:7002', 'specialist', 'boris', 'v1_boris_text', 'v1', true],
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
      ['v1:7002:bid:0', 'c7', 'v1'],
      ['v1:7002:boris:0', 'c7', 'v1'],
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

  it("FR-CONV-10: the export after the switch takes an unproven specialist message for Boris's", async () => {
    await raw({ chat: 'c1', author: 'specialist', text: 'Сам напишу' })
    await run(null, { v1Writes: false })
    const [row] = await db.select().from(chatMessage).where(eq(chatMessage.chatId, 'c1'))
    expect(row).toMatchObject({ author: 'boris', authorBasis: 'after_cutover' })
  })
})
