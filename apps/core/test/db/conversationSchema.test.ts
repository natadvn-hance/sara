import { newEventId } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { chatMessage, conversation, mindIndex, mindProposal } from '../../src/db/schema'
import { dbErrorMessage, openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const message = (platformMessageId: string) => ({
  id: newEventId(),
  accountId: 'hance-marketing',
  chatId: '95147898',
  orderId: '95147898',
  platformMessageId,
  side: 'client',
  author: 'client',
  authorBasis: 'side',
  text: 'Сколько стоит сайт?',
  sentAt: '2026-10-20T10:00:00.000Z',
  source: 'node',
})

describe('M4 tables', () => {
  it('FR-CONV-2: a platform message is stored once per account', async () => {
    await db.insert(chatMessage).values(message('m-1'))
    expect(await dbErrorMessage(db.insert(chatMessage).values(message('m-1')))).toMatch(/unique/)
    await db.insert(chatMessage).values({ ...message('m-1'), id: newEventId(), accountId: 'other' })
  })

  it('FR-CONV-10: one conversation per account chat, owned by Sara until told otherwise', async () => {
    const row = { id: newEventId(), accountId: 'hance-marketing', chatId: '95147898' }
    await db.insert(conversation).values(row)
    const [c] = await db.select().from(conversation).where(eq(conversation.id, row.id))
    expect(c).toMatchObject({ owner: 'sara', origin: 'v1', unclearCount: 0, closedAt: null })
    expect(
      await dbErrorMessage(db.insert(conversation).values({ ...row, id: newEventId() })),
    ).toMatch(/unique/)
  })

  it('FR-MIND-2: the index finds Russian word forms and keeps a 384-number vector', async () => {
    await db.insert(mindIndex).values({
      recordId: 'k-site-price',
      path: 'mind/shared/knowledge/k-site-price.md',
      type: 'knowledge',
      scope: 'shared',
      title: 'Стоимость сайтов',
      body: 'Сайт под ключ',
      version: 1,
      mindVersion: 'abc',
      tsv: sql`to_tsvector('russian', 'Стоимость сайтов. Сайт под ключ')`,
      embedding: Array.from({ length: 384 }, () => 0.01),
    })
    const found = await db.execute(
      sql`select record_id from core.mind_index where tsv @@ plainto_tsquery('russian', 'стоимости сайта')`,
    )
    expect(found.rows).toEqual([{ record_id: 'k-site-price' }])
  })

  it('FR-MIND-3: a proposal path is stored once', async () => {
    const p = {
      id: newEventId(),
      path: 'mind/proposals/shared/speech/examples/e-h-1.md',
      content: '---\nid: e-h-1\n---\n',
      kind: 'example',
      source: 'history:hance-marketing:1',
    }
    await db.insert(mindProposal).values(p)
    const [row] = await db.select().from(mindProposal)
    expect(row?.state).toBe('new')
    expect(
      await dbErrorMessage(db.insert(mindProposal).values({ ...p, id: newEventId() })),
    ).toMatch(/unique/)
  })
})
