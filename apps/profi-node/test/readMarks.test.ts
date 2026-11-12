import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { outboxNode, rawMessage } from '../src/db/schema'
import { createEyes } from '../src/eyes/eyes'
import { standInParsers } from '../src/eyes/parsers'
import { openNodeTestDb, resetNodeDb } from './helpers/db'

// Whether the client read our messages (Boris, 12.11.2026: «Сара не видит, прочитала ли она отклик или нет»). The chat
// page does not say it; the chat's own answer does, message by message (whoRead), each time the node opens the chat.

const { db, close } = openNodeTestDb()
const ACC = 'hance-marketing'
const CHAT = '95900001'

beforeEach(() => resetNodeDb(db))
afterAll(() => close())

const eyesNow = () => createEyes({ accountId: ACC, db, parsers: standInParsers })

const msg = (id: string, author: 'client' | 'specialist', chat = CHAT) => ({
  t: 'message' as const,
  message: {
    platform_message_id: id,
    chat_id: chat,
    order_id: chat,
    author,
    sent_at: '2026-11-10T09:00:00.000Z',
    text: author === 'client' ? 'Нужен сайт' : 'Здравствуйте! Сделаем.',
    // What a chat page says of every bubble: it never knows whether the client read ours.
    read: true,
  },
})
const page = (signals: ReturnType<typeof msg>[]) => ({
  recognized: true,
  what: 'chat' as const,
  signals,
})
const answer = (messageIds: string[]) => ({
  recognized: true,
  what: 'chat' as const,
  signals: [{ t: 'read_by_client' as const, messageIds }],
})
const outbox = async () =>
  (await db.select().from(outboxNode).orderBy(asc(outboxNode.eventId))).map(
    (r) =>
      r.payload as {
        type: string
        entity: { kind: string; id: string }
        payload: Record<string, unknown>
      },
  )
const reads = async () => (await outbox()).filter((e) => e.type === 'profi.client_read')
const readOf = async (id: string) =>
  (await db.select().from(rawMessage).where(eq(rawMessage.platformMessageId, id)))[0]?.read

/** A chat Sara watches: the client wrote first (news), then our two messages came after it. */
async function watchedChat(eyes = eyesNow()) {
  await eyes.onChatRead(CHAT, page([msg('30', 'client')]))
  await eyes.onChatRead(
    CHAT,
    page([msg('30', 'client'), msg('31', 'specialist'), msg('32', 'specialist')]),
  )
  return eyes
}

describe('the client read our messages, by the chat answer', () => {
  it('FR-CONV-12: our message is stored unread, whatever the page says', async () => {
    await watchedChat()
    expect(await readOf('31')).toBe(false)
    expect(await readOf('32')).toBe(false)
    // The client's words were read by us when the page showed them.
    expect(await readOf('30')).toBe(true)
  })

  it('FR-CONV-12: a stored unread message of ours that comes back read is read, with ours before it; one event names it', async () => {
    const eyes = await watchedChat()
    await eyes.onParsed(answer(['32']), 'response')
    expect(await readOf('32')).toBe(true)
    // The client read the last one: ours before it are read too.
    expect(await readOf('31')).toBe(true)
    const [read, ...more] = await reads()
    expect(more).toEqual([])
    expect(read?.entity).toEqual({ kind: 'chat', id: CHAT })
    expect(read?.payload).toMatchObject({
      chat_id: CHAT,
      order_id: CHAT,
      platform_message_id: '32',
    })
    expect(Number.isNaN(Date.parse(String(read?.payload.at)))).toBe(false)
  })

  it('FR-CONV-12: the same read again queues nothing, also after a restart of the node', async () => {
    const eyes = await watchedChat()
    await eyes.onParsed(answer(['31', '32']), 'response')
    await eyes.onParsed(answer(['31', '32']), 'response')
    await eyesNow().onParsed(answer(['31', '32']), 'response')
    expect(await reads()).toHaveLength(1)
  })

  it('FR-CONV-12: a read of an earlier message after the last one was read is no news', async () => {
    const eyes = await watchedChat()
    await eyes.onParsed(answer(['32']), 'response')
    await eyes.onParsed(answer(['31']), 'response')
    expect(await reads()).toHaveLength(1)
  })

  it('FR-CONV-12: the answer may come before the page stores the message: the read counts once it is stored, after its own event', async () => {
    const eyes = eyesNow()
    await eyes.onChatRead(CHAT, page([msg('30', 'client')]))
    // The site's answer of the chat page comes first, the bubbles are read from the page a moment later.
    await eyes.onParsed(answer(['33']), 'response')
    await eyes.onChatRead(CHAT, page([msg('30', 'client'), msg('33', 'specialist')]))
    expect(await readOf('33')).toBe(true)
    const types = (await outbox()).map((e) => e.type)
    expect(types).toEqual(['profi.client_message', 'profi.specialist_message', 'profi.client_read'])
    expect((await reads())[0]?.payload.platform_message_id).toBe('33')
  })

  it('FR-CONV-12: an old chat from before Sara gets no event: its messages are history', async () => {
    const eyes = eyesNow()
    const OLD = '95900002'
    // The first reading of a chat: everything up to our last message was there before Sara watched.
    await eyes.onChatRead(OLD, page([msg('40', 'client', OLD), msg('41', 'specialist', OLD)]))
    await eyes.onParsed(answer(['41']), 'response')
    expect(await reads()).toEqual([])
  })

  it('FR-CONV-12: our bid kept as history counts once the core knows the chat from a client message after it', async () => {
    const eyes = eyesNow()
    const BID = '95900003'
    // Boris bid from the site himself: the first reading keeps the bid as history, the client's answer is news.
    await eyes.onChatRead(BID, page([msg('50', 'specialist', BID)]))
    await eyes.onChatRead(BID, page([msg('50', 'specialist', BID), msg('51', 'client', BID)]))
    await eyes.onParsed(answer(['50']), 'response')
    const [read, ...more] = await reads()
    expect(more).toEqual([])
    expect(read?.payload).toMatchObject({ chat_id: BID, platform_message_id: '50' })
  })

  it('FR-CONV-12: a client message or a message the node does not hold is never made read by the answer', async () => {
    const eyes = await watchedChat()
    await eyes.onParsed(answer(['30', 'unknown-id']), 'response')
    expect(await reads()).toEqual([])
    expect(await readOf('31')).toBe(false)
  })
})
