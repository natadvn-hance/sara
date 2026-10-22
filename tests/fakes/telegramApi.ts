// Fake Telegram Bot API for tests: enough of getMe, getUpdates, sendMessage and callbacks for grammY.
import { createServer } from 'node:http'

export type SentMessage = {
  chat_id: number
  text: string
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] }
  disable_notification?: boolean
}

export type FakeTelegram = {
  apiRoot: string
  token: string
  username: string
  sent: SentMessage[]
  answers: { callback_query_id: string; text?: string }[]
  pushStart(chatId: number): void
  pushPress(chatId: number, data: string): string
  /** Simulates another program polling the same bot: getUpdates answers 409. */
  setConflict(on: boolean): void
  close(): Promise<void>
}

export const FAKE_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop'

export async function createFakeTelegram(port = 0): Promise<FakeTelegram> {
  const sent: SentMessage[] = []
  const answers: { callback_query_id: string; text?: string }[] = []
  const updates: Record<string, unknown>[] = []
  let nextUpdate = 1
  let nextMessage = 100
  let nextCallback = 1
  let conflict = false
  const now = () => Math.floor(Date.now() / 1000)

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', async () => {
      const m = /^\/bot([^/]+)\/(\w+)/.exec(req.url ?? '')
      const reply = (result: unknown) =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, result }))
      if (!m) return res.writeHead(404).end()
      const [, token, method] = m
      if (token !== FAKE_TOKEN) {
        return res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
      }
      const params = body ? JSON.parse(body) : {}
      switch (method) {
        case 'getMe':
          return reply({ id: 1, is_bot: true, first_name: 'Сара', username: 'sara_dev_bot' })
        case 'getUpdates': {
          if (conflict) {
            return res.writeHead(409, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                ok: false,
                error_code: 409,
                description: 'Conflict: terminated by other getUpdates request',
              }),
            )
          }
          const offset = params.offset ?? 0
          // Like Telegram: updates below the offset are confirmed and never sent again.
          for (let i = updates.length - 1; i >= 0; i--) {
            if ((updates[i]?.update_id as number) < offset) updates.splice(i, 1)
          }
          const until = Date.now() + 200
          while (Date.now() < until && !updates.some((u) => (u.update_id as number) >= offset)) {
            await new Promise((r) => setTimeout(r, 20))
          }
          return reply(updates.filter((u) => (u.update_id as number) >= offset))
        }
        case 'sendMessage': {
          sent.push(params)
          return reply({
            message_id: nextMessage++,
            date: now(),
            chat: { id: params.chat_id, type: 'private' },
            text: params.text,
          })
        }
        case 'answerCallbackQuery':
          answers.push(params)
          return reply(true)
        default:
          return reply(true)
      }
    })
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const actual = (server.address() as { port: number }).port

  return {
    apiRoot: `http://127.0.0.1:${actual}`,
    token: FAKE_TOKEN,
    username: 'sara_dev_bot',
    sent,
    answers,
    pushStart(chatId) {
      updates.push({
        update_id: nextUpdate++,
        message: {
          message_id: nextMessage++,
          date: now(),
          chat: { id: chatId, type: 'private' },
          from: { id: chatId, is_bot: false, first_name: 'Борис' },
          text: '/start',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      })
    },
    pushPress(chatId, data) {
      const id = String(nextCallback++)
      updates.push({
        update_id: nextUpdate++,
        callback_query: {
          id,
          from: { id: chatId, is_bot: false, first_name: 'Борис' },
          chat_instance: 'fake',
          data,
          message: {
            message_id: 1,
            date: now(),
            chat: { id: chatId, type: 'private' },
            text: 'card',
          },
        },
      })
      return id
    },
    setConflict(on) {
      conflict = on
    },
    close: () => new Promise((r) => server.close(() => r())),
  }
}
