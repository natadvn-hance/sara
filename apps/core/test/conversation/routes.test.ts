import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { startSession } from '../../src/auth/session'
import { sendTextNow } from '../../src/conversation/outbox'
import { registerConversationRoutes } from '../../src/conversation/routes'
import { ensureConversation, getConversation } from '../../src/conversation/store'
import { outbox } from '../../src/db/schema'
import { setSetting } from '../../src/settings/store'
import { chatMsg, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
let app: FastifyInstance
let session = ''
afterAll(async () => {
  await app?.close()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  await app?.close()
  app = Fastify()
  await app.register(cookie, { secret: 'test-secret' })
  app.post('/login', async (_req, reply) => {
    startSession(reply, false)
    return {}
  })
  registerConversationRoutes(app, { db, notifier: { sendText: async () => ({ messageId: 1 }) } })
  const r = await app.inject({ method: 'POST', url: '/login' })
  session = String(r.headers['set-cookie']).split(';')[0] ?? ''
})

describe('conversation API', () => {
  it('FR-CONV-11: the pult takes, gives back, writes and closes through the same commands', async () => {
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-1',
      orderId: null,
    })
    const post = (path: string, body?: object) =>
      app.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/${path}`,
        headers: { cookie: session },
        payload: body ?? {},
      })
    expect((await post('take')).statusCode).toBe(200)
    expect((await getConversation(db, conv.id))?.owner).toBe('boris')
    expect((await post('return', { note: 'мягче' })).json().message).toMatch(/Вернула/)
    expect((await getConversation(db, conv.id))?.borisNote).toContain('мягче')
    expect((await post('say', { text: 'Добрый день' })).json().message).toMatch(/Режим тени/)
    expect((await post('say', { text: '' })).statusCode).toBe(400)
    expect((await post('close')).statusCode).toBe(200)
    expect((await getConversation(db, conv.id))?.closedAt).not.toBeNull()
  })

  it('FR-CONV-11: without the owner’s session nothing changes, an unknown conversation is 404', async () => {
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-1',
      orderId: null,
    })
    const r = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/take` })
    expect(r.statusCode).toBe(401)
    expect((await getConversation(db, conv.id))?.owner).toBe('sara')
    const missing = await app.inject({
      method: 'POST',
      url: '/api/conversations/0192f3c4-5b6a-7c8d-9e0f-112233445566/take',
      headers: { cookie: session },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('FR-CONV-9: the same key of the pult sends one message, no key sends each time', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'system')
    const profi = stubProfi([chatMsg('m-1', 'client', 'Привет', new Date().toISOString(), 'c-2')])
    const sent: string[] = []
    profi.sendMessage = async (i) => {
      sent.push(i.idempotency_key)
      return { found_on_page: true, platform_message_id: `sent-${sent.length}` }
    }
    const withSend = Fastify()
    await withSend.register(cookie, { secret: 'test-secret' })
    withSend.post('/login', async (_req, reply) => {
      startSession(reply, false)
      return {}
    })
    registerConversationRoutes(withSend, {
      db,
      notifier: { sendText: async () => ({ messageId: 1 }) },
      sendText: (c, text, author, o) => sendTextNow({ db, profi }, c, text, author, o),
    })
    const login = await withSend.inject({ method: 'POST', url: '/login' })
    const cookieHeader = String(login.headers['set-cookie']).split(';')[0] ?? ''
    const conv = await ensureConversation(db, {
      accountId: 'hance-marketing',
      chatId: 'c-2',
      orderId: null,
    })
    const say = (body: object) =>
      withSend.inject({
        method: 'POST',
        url: `/api/conversations/${conv.id}/say`,
        headers: { cookie: cookieHeader },
        payload: body,
      })
    expect((await say({ text: 'Добрый день', key: 'pult-1' })).statusCode).toBe(200)
    expect((await say({ text: 'Добрый день', key: 'pult-1' })).statusCode).toBe(200)
    expect(await db.select().from(outbox)).toHaveLength(1)
    expect(sent).toEqual(['msg:say:api:pult-1'])
    await say({ text: 'Ещё раз' })
    await say({ text: 'Ещё раз' })
    expect(await db.select().from(outbox)).toHaveLength(3)
    expect((await say({ text: 'Добрый день', key: 'x'.repeat(101) })).statusCode).toBe(400)
    await withSend.close()
  })
})
