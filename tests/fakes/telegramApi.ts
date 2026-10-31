// Fake Telegram Bot API for tests: enough of getMe, getUpdates, sendMessage and callbacks for grammY.
import { createServer } from 'node:http'

export type SentMessage = {
  /** The number the fake gave the message when it was sent. */
  message_id?: number
  chat_id: number
  /** The forum topic it went to; none for a private chat or the General topic. */
  message_thread_id?: number
  text: string
  parse_mode?: string
  link_preview_options?: { is_disabled?: boolean }
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] }
  disable_notification?: boolean
}

/** A message the bot edited (editMessageText); `reply_markup` with no rows is the buttons taken away. */
export type EditedMessage = {
  chat_id: number
  message_id: number
  text: string
  parse_mode?: string
  link_preview_options?: { is_disabled?: boolean }
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] }
}

/** A topic of a forum group, as the fake keeps it. */
export type FakeTopic = {
  chat_id: number
  message_thread_id: number
  name: string
  closed: boolean
}

/** A message of Boris's (or anyone's) in a group: a forum topic when `thread` is given. */
export type GroupText = {
  chatId: number
  fromId: number
  text: string
  thread?: number
  replyTo?: number
  title?: string
  /** False: a group without topics. */
  forum?: boolean
}

export type FakeTelegram = {
  apiRoot: string
  token: string
  username: string
  sent: SentMessage[]
  /** Edits Telegram accepted, in order (refused ones are not here): closed cards, the M4 shadow card. */
  edited: EditedMessage[]
  /** Buttons replaced on a sent message (editMessageReplyMarkup): a card decided in the pult. */
  markups: { message_id: number; reply_markup: EditedMessage['reply_markup'] }[]
  answers: { callback_query_id: string; text?: string }[]
  /** sendChatAction calls («печатает…»), in order. */
  actions: string[]
  pushStart(chatId: number): void
  pushPress(chatId: number, data: string): string
  /** A text message from Boris, optionally a reply to one of the bot's messages. */
  pushText(chatId: number, text: string, replyTo?: number): void
  /** A voice message; its file is served by the fake file endpoint. */
  pushVoice(chatId: number, replyTo?: number): void
  /** getFile answers an error, like Telegram losing a file. */
  setFileBroken(on: boolean): void
  /** Simulates another program polling the same bot: getUpdates answers 409. */
  setConflict(on: boolean): void
  /** Every HTML message, and every HTML edit, is refused like markup Telegram cannot parse (plain ones go through). */
  setRejectHtml(on: boolean): void
  /** editMessageText of this message answers an error like Telegram's (a deleted message, say); null clears it. */
  setEditError(messageId: number, description: string | null): void
  /** sendMessage answers this many ms late: the message is in `sent` at once, the caller waits (a slow Telegram). */
  setSendDelay(ms: number): void
  /** Forum topics made by the bot, with their names and whether they are closed. */
  topics: FakeTopic[]
  /** Calls the fake answers with a plain `true` (setMyCommands, setChatMenuButton...), in order. */
  calls: { method: string; params: Record<string, unknown> }[]
  pushGroupText(m: GroupText): void
  /** A press in a group, by `fromId`, on a message in `thread`. */
  pushGroupPress(chatId: number, fromId: number, data: string, thread?: number): string
  /** The bot's own membership changed (taken out of the group: `left` or `kicked`). */
  pushMyChatMember(chatId: number, fromId: number, status: string): void
  /** What getChatMember says about the bot: an admin who may manage topics by default. */
  setBotRights(r: { admin: boolean; canManageTopics: boolean }): void
  /** Every send to this chat answers 403 like a group the bot was removed from; null clears it. */
  setChatGone(chatId: number | null): void
  /** A topic deleted by hand: sends to it answer «message thread not found». */
  deleteTopic(chatId: number, threadId: number): void
  close(): Promise<void>
}

const HTML_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'a',
  'code',
  'pre',
  'blockquote',
])
const HTML_ENTITIES = /^&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/i

/**
 * What the real Bot API refuses in parse_mode HTML, as an error text (null: accepted): a tag it does not know or
 * does not close, a bare < or &, and a message over 4096 characters after the tags and entities are parsed.
 */
export function htmlProblem(html: string): string | null {
  const open: string[] = []
  let visible = 0
  for (let i = 0; i < html.length; ) {
    const ch = html[i]
    if (ch === '<') {
      const m = /^<(\/?)([a-z-]+)(?:\s[^<>]*)?>/i.exec(html.slice(i))
      if (!m || !HTML_TAGS.has((m[2] ?? '').toLowerCase()))
        return `can't parse entities: unsupported start tag at byte offset ${i}`
      const name = (m[2] ?? '').toLowerCase()
      if (m[1]) {
        if (open.pop() !== name)
          return `can't parse entities: unmatched end tag at byte offset ${i}`
      } else open.push(name)
      i += m[0].length
    } else if (ch === '&') {
      const m = HTML_ENTITIES.exec(html.slice(i))
      if (!m) return `can't parse entities: unsupported entity at byte offset ${i}`
      visible += 1
      i += m[0].length
    } else if (ch === '>') {
      return `can't parse entities: unescaped > at byte offset ${i}`
    } else {
      visible += 1
      i += 1
    }
  }
  if (open.length > 0) return `can't parse entities: unclosed tag ${open.at(-1)}`
  if (visible > 4096) return 'message is too long'
  if (visible === 0) return 'message text is empty'
  return null
}

export const FAKE_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop'

export async function createFakeTelegram(port = 0): Promise<FakeTelegram> {
  const sent: SentMessage[] = []
  const edited: EditedMessage[] = []
  const markups: FakeTelegram['markups'] = []
  /** What each message shows now (text and buttons), so an edit that changes nothing is refused like Telegram does. */
  const shown = new Map<string, string>()
  const editErrors = new Map<number, string>()
  const answers: { callback_query_id: string; text?: string }[] = []
  const actions: string[] = []
  const updates: Record<string, unknown>[] = []
  let nextUpdate = 1
  /** Like Telegram, every chat numbers its own messages. */
  const counters = new Map<number, number>()
  const nextId = (chat: number) => {
    const n = counters.get(chat) ?? 100
    counters.set(chat, n + 1)
    return n
  }
  const topics: FakeTopic[] = []
  const calls: FakeTelegram['calls'] = []
  const deletedTopics = new Set<string>()
  let botRights = { admin: true, canManageTopics: true }
  let goneChat: number | null = null
  const refuse = (res: import('node:http').ServerResponse, code: number, description: string) =>
    res
      .writeHead(code, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: false, error_code: code, description }))
  const topicOf = (chat: number, thread: number) =>
    topics.find((t) => t.chat_id === chat && t.message_thread_id === thread)
  let nextCallback = 1
  let conflict = false
  let fileBroken = false
  let rejectHtml = false
  let sendDelayMs = 0
  const now = () => Math.floor(Date.now() / 1000)

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', async () => {
      // Files, like Telegram: GET /file/bot<token>/<file_path>.
      if ((req.url ?? '').startsWith(`/file/bot${FAKE_TOKEN}/`)) {
        return res.writeHead(200, { 'content-type': 'audio/ogg' }).end('OggS fake voice')
      }
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
          if (goneChat !== null && Number(params.chat_id) === goneChat)
            return refuse(res, 403, 'Forbidden: bot was kicked from the supergroup chat')
          if (
            params.message_thread_id !== undefined &&
            deletedTopics.has(`${params.chat_id}:${params.message_thread_id}`)
          )
            return refuse(res, 400, 'Bad Request: message thread not found')
          const problem =
            params.parse_mode === 'HTML'
              ? rejectHtml
                ? "can't parse entities: unsupported start tag at byte offset 0"
                : htmlProblem(String(params.text))
              : String(params.text).length > 4096
                ? 'message is too long'
                : null
          if (problem) {
            return res.writeHead(400, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                ok: false,
                error_code: 400,
                description: `Bad Request: ${problem}`,
              }),
            )
          }
          const id = nextId(Number(params.chat_id))
          sent.push({ ...params, message_id: id })
          shown.set(
            `${params.chat_id}:${id}`,
            JSON.stringify([params.text, params.reply_markup ?? null]),
          )
          if (sendDelayMs > 0) await new Promise((r) => setTimeout(r, sendDelayMs))
          return reply({
            message_id: id,
            date: now(),
            chat: { id: params.chat_id, type: 'private' },
            text: params.text,
          })
        }
        case 'editMessageText': {
          const id = Number(params.message_id)
          const problem =
            editErrors.get(id) ??
            (params.parse_mode === 'HTML'
              ? rejectHtml
                ? "can't parse entities: unsupported start tag at byte offset 0"
                : htmlProblem(String(params.text))
              : String(params.text).length > 4096
                ? 'message is too long'
                : null) ??
            (shown.get(`${params.chat_id}:${id}`) ===
            JSON.stringify([params.text, params.reply_markup ?? null])
              ? 'message is not modified: the new text and buttons are the same as the current ones'
              : null)
          if (problem) {
            return res.writeHead(400, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                ok: false,
                error_code: 400,
                description: `Bad Request: ${problem}`,
              }),
            )
          }
          edited.push(params)
          shown.set(
            `${params.chat_id}:${id}`,
            JSON.stringify([params.text, params.reply_markup ?? null]),
          )
          return reply({
            message_id: id,
            date: now(),
            chat: { id: params.chat_id, type: 'private' },
            text: params.text,
          })
        }
        case 'getFile':
          if (fileBroken) {
            return res.writeHead(400, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                ok: false,
                error_code: 400,
                description: 'Bad Request: file is too big',
              }),
            )
          }
          return reply({
            file_id: params.file_id,
            file_unique_id: `u-${params.file_id}`,
            file_size: 15,
            file_path: `voice/${params.file_id}.oga`,
          })
        case 'getChatMember':
          return reply({
            status: botRights.admin ? 'administrator' : 'member',
            user: { id: Number(params.user_id), is_bot: true, first_name: 'Сара' },
            ...(botRights.admin && { can_manage_topics: botRights.canManageTopics }),
          })
        case 'createForumTopic': {
          if (!botRights.admin || !botRights.canManageTopics)
            return refuse(res, 400, 'Bad Request: not enough rights to create a topic')
          const chat = Number(params.chat_id)
          // The topic's number is the number of its first service message.
          const topic = {
            chat_id: chat,
            message_thread_id: nextId(chat),
            name: String(params.name),
            closed: false,
          }
          topics.push(topic)
          return reply({
            message_thread_id: topic.message_thread_id,
            name: topic.name,
            icon_color: 7322096,
          })
        }
        case 'editForumTopic':
        case 'closeForumTopic':
        case 'reopenForumTopic': {
          const t = topicOf(Number(params.chat_id), Number(params.message_thread_id))
          if (!t) return refuse(res, 400, 'Bad Request: TOPIC_ID_INVALID')
          const same =
            method === 'editForumTopic'
              ? t.name === params.name
              : t.closed === (method === 'closeForumTopic')
          if (same) return refuse(res, 400, 'Bad Request: TOPIC_NOT_MODIFIED')
          if (method === 'editForumTopic') t.name = String(params.name)
          else t.closed = method === 'closeForumTopic'
          return reply(true)
        }
        case 'editMessageReplyMarkup':
          markups.push({ message_id: Number(params.message_id), reply_markup: params.reply_markup })
          return reply(true)
        case 'answerCallbackQuery':
          answers.push(params)
          return reply(true)
        case 'sendChatAction':
          actions.push(String(params.action))
          return reply(true)
        default:
          calls.push({ method: method ?? '', params })
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
    edited,
    markups,
    answers,
    actions,
    pushStart(chatId) {
      updates.push({
        update_id: nextUpdate++,
        message: {
          message_id: nextId(chatId),
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
    pushText(chatId, text, replyTo) {
      updates.push({
        update_id: nextUpdate++,
        message: {
          message_id: nextId(chatId),
          date: now(),
          chat: { id: chatId, type: 'private' },
          from: { id: chatId, is_bot: false, first_name: 'Борис' },
          text,
          // A command is a command for the bot, as in Telegram.
          ...(/^\/\w+(?:@\w+)?/.test(text) && {
            entities: [
              { type: 'bot_command', offset: 0, length: /^\/\w+(?:@\w+)?/.exec(text)?.[0].length },
            ],
          }),
          ...(replyTo
            ? {
                reply_to_message: {
                  message_id: replyTo,
                  date: now(),
                  chat: { id: chatId, type: 'private' },
                  text: 'вопрос',
                },
              }
            : {}),
        },
      })
    },
    pushVoice(chatId, replyTo) {
      const messageId = nextId(chatId)
      const fileId = `voice-${chatId}-${messageId}`
      updates.push({
        update_id: nextUpdate++,
        message: {
          message_id: messageId,
          date: now(),
          chat: { id: chatId, type: 'private' },
          from: { id: chatId, is_bot: false, first_name: 'Борис' },
          voice: {
            file_id: fileId,
            file_unique_id: `u-${fileId}`,
            duration: 3,
            mime_type: 'audio/ogg',
          },
          ...(replyTo
            ? {
                reply_to_message: {
                  message_id: replyTo,
                  date: now(),
                  chat: { id: chatId, type: 'private' },
                  text: 'вопрос',
                },
              }
            : {}),
        },
      })
    },
    setFileBroken(on) {
      fileBroken = on
    },
    setConflict(on) {
      conflict = on
    },
    setRejectHtml(on) {
      rejectHtml = on
    },
    setEditError(messageId, description) {
      if (description === null) editErrors.delete(messageId)
      else editErrors.set(messageId, description)
    },
    setSendDelay(ms) {
      sendDelayMs = ms
    },
    topics,
    calls,
    pushGroupText(m) {
      const chat = {
        id: m.chatId,
        type: 'supergroup',
        title: m.title ?? 'Сара · клиенты',
        ...(m.forum !== false && { is_forum: true }),
      }
      const command = /^\/\w+(?:@\w+)?/.exec(m.text)?.[0]
      const topic = m.thread !== undefined ? topicOf(m.chatId, m.thread) : undefined
      // In a topic a message that replies to nothing points at the topic's first service message, as in Telegram.
      const replyTo =
        m.replyTo !== undefined
          ? { message_id: m.replyTo, date: now(), chat, text: 'сообщение' }
          : m.thread !== undefined
            ? {
                message_id: m.thread,
                date: now(),
                chat,
                forum_topic_created: { name: topic?.name ?? 'тема', icon_color: 7322096 },
              }
            : undefined
      updates.push({
        update_id: nextUpdate++,
        message: {
          message_id: nextId(m.chatId),
          date: now(),
          chat,
          from: { id: m.fromId, is_bot: false, first_name: 'Борис' },
          text: m.text,
          ...(command && {
            entities: [{ type: 'bot_command', offset: 0, length: command.length }],
          }),
          ...(m.thread !== undefined && { message_thread_id: m.thread, is_topic_message: true }),
          ...(replyTo && { reply_to_message: replyTo }),
        },
      })
    },
    pushGroupPress(chatId, fromId, data, thread) {
      const id = String(nextCallback++)
      updates.push({
        update_id: nextUpdate++,
        callback_query: {
          id,
          from: { id: fromId, is_bot: false, first_name: 'Борис' },
          chat_instance: 'fake-group',
          data,
          message: {
            message_id: 1,
            date: now(),
            chat: { id: chatId, type: 'supergroup', title: 'Сара · клиенты', is_forum: true },
            text: 'card',
            ...(thread !== undefined && { message_thread_id: thread, is_topic_message: true }),
          },
        },
      })
      return id
    },
    pushMyChatMember(chatId, fromId, status) {
      updates.push({
        update_id: nextUpdate++,
        my_chat_member: {
          chat: { id: chatId, type: 'supergroup', title: 'Сара · клиенты', is_forum: true },
          from: { id: fromId, is_bot: false, first_name: 'Борис' },
          date: now(),
          old_chat_member: {
            status: 'administrator',
            user: { id: 1, is_bot: true, first_name: 'Сара' },
          },
          new_chat_member: { status, user: { id: 1, is_bot: true, first_name: 'Сара' } },
        },
      })
    },
    setBotRights(r) {
      botRights = r
    },
    setChatGone(chatId) {
      goneChat = chatId
    },
    deleteTopic(chatId, threadId) {
      deletedTopics.add(`${chatId}:${threadId}`)
      const i = topics.findIndex((t) => t.chat_id === chatId && t.message_thread_id === threadId)
      if (i >= 0) topics.splice(i, 1)
    },
    close: () => new Promise((r) => server.close(() => r())),
  }
}
