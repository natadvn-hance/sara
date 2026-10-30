import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newEventId, parseCallback, type TaskAction } from '@sara/shared'
import { Bot, type Context, GrammyError } from 'grammy'
import type { Message } from 'grammy/types'
import type { Db } from '../db/client'
import { appendEvent } from '../journal/journal'
import { quietNow } from '../leads/cardFlow'
import type { BorisMessage, BorisReply } from '../learning/inbox'
import { bindChat, boundChat, boundUser } from './binding'
import { COMMANDS, type CommandReply } from './botCommands'
import { closedLeadCardText, leadCardKeyboard, leadCardText, plainFallback, TEXTS } from './cards'
import {
  bindForum,
  CLOSED_MARK,
  conversationOfTopic,
  dropTopic,
  type Forum,
  forumOf,
  isClientPlace,
  linkTopic,
  markTopic,
  postOf,
  postRef,
  saveTopic,
  topicByKey,
  topicByThread,
  topicIntro,
  topicKey,
  unbindForum,
} from './forum'
import type { Notifier, Place } from './notifier'

type SendOptions = NonNullable<Parameters<Bot['api']['sendMessage']>[2]>

export type TelegramRuntime = {
  start(): Promise<void>
  stop(): Promise<void>
  /** Why polling stopped by itself (revoked token, another program on the same bot), in plain words. */
  lastError(): string | null
  botUsername(): string | null
  notifier: Notifier
}

/** A long or en dash, which the model, a voice or an order text can bring; Boris never gets one. */
const DASHES = /[\u2013\u2014]/g
/** The same dashes written as numeric entities, which Telegram's HTML would turn back into dashes. */
const DASH_ENTITIES = /&#(?:x0*(?:2013|2014)|0*(?:8211|8212));/gi

/** Dashes become hyphens in the text of an HTML message only, never inside a tag (a link keeps its address). */
function hyphenateHtml(html: string): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part) =>
      part.startsWith('<') ? part : part.replace(DASHES, '-').replace(DASH_ENTITIES, '-'),
    )
    .join('')
}

function chatOf(ctx: Context): number | undefined {
  return ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id ?? ctx.from?.id
}

/** `/forum` or `/forum_off`, the only words a group not yet bound is heard for. */
const FORUM_COMMAND = /^\/forum(?:_off)?(?:@\w+)?(?:\s|$)/

/** Telegram has no such topic any more (deleted by hand): it is made again. */
const TOPIC_GONE = /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i
/** The topic is closed to the bot: it is opened, then the message goes. */
const TOPIC_CLOSED = /TOPIC_CLOSED/i
/** The forum as a whole refuses the bot (removed, no rights, the group gone): Boris's own chat takes the message. */
function forumRefused(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false
  return (
    err.error_code === 403 ||
    /chat not found|CHAT_WRITE_FORBIDDEN|not enough rights|have no rights|upgraded to a supergroup/i.test(
      err.description,
    )
  )
}
const short = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : String(e))

/** The bot obeys only the chat bound by the first /start (threat model T9). */
const keyboard = (rows: { text: string; callbackData: string }[][]) =>
  rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.callbackData })))

export function createTelegramRuntime(d: {
  token: string
  apiRoot?: string
  db: Db
  onPress(p: { taskId: string; action: TaskAction }): Promise<string>
  /** Boris's text or voice (saved to a file first); the answer goes back to him. */
  onMessage?(m: BorisMessage): Promise<BorisReply>
  /** Where voice messages are saved while they are recognized (default: the system temp folder). */
  voiceDir?: string
  /** The pult's address, for /pult and the commands that point at it. */
  publicUrl?: string
}): TelegramRuntime {
  const bot = new Bot(d.token, d.apiRoot ? { client: { apiRoot: d.apiRoot } } : undefined)
  // Every text leaves through here (messages, replies, button answers), so a dash in it becomes a short hyphen once.
  bot.api.config.use((prev, method, payload, signal) => {
    const { text, parse_mode: mode } = payload as { text?: unknown; parse_mode?: unknown }
    if (typeof text !== 'string') return prev(method, payload, signal)
    const hyphenated = mode === 'HTML' ? hyphenateHtml(text) : text.replace(DASHES, '-')
    return prev(method, { ...payload, text: hyphenated }, signal)
  })

  async function logForeign(chatId: number | undefined): Promise<void> {
    await appendEvent(d.db, {
      type: 'security.foreign_chat',
      v: 1,
      entity: { kind: 'telegram_chat', id: String(chatId ?? 'unknown') },
      account_id: null,
      actor: 'system',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: 'update from a chat that is not bound',
      payload: { chat_id: chatId ?? null },
    })
  }

  bot.use(async (ctx, next) => {
    const chatId = chatOf(ctx)
    const bound = await boundChat(d.db)
    const isStart = ctx.message?.text?.startsWith('/start') ?? false
    if ((bound === null && isStart) || (bound !== null && chatId === bound)) return next()
    if (bound !== null && chatId !== undefined && ctx.chat?.type === 'supergroup') {
      const forum = await forumOf(d.db)
      // The bot taken out of Boris's forum, by whoever: everything goes back to his chat.
      if (ctx.myChatMember && forum?.chatId === chatId) return next()
      // In a group only Boris's own updates count, whoever else is in it (T9).
      if (ctx.from?.id === (await boundUser(d.db))) {
        if (forum?.chatId === chatId) return next()
        if (FORUM_COMMAND.test(ctx.message?.text ?? '')) return next()
      }
    }
    await logForeign(chatId)
  })

  bot.command('start', async (ctx) => {
    if ((await boundChat(d.db)) === null && ctx.chat && ctx.from) {
      await bindChat(d.db, ctx.chat.id, ctx.from.id)
      await appendEvent(d.db, {
        type: 'telegram.bound',
        v: 1,
        entity: { kind: 'telegram_chat', id: String(ctx.chat.id) },
        account_id: null,
        actor: 'boris',
        occurred_at: new Date().toISOString(),
        causation_id: null,
        correlation_id: newEventId(),
        reason: null,
        payload: {},
      })
    }
    await ctx.reply(TEXTS.bound)
  })

  async function journal(
    type: 'telegram.forum_bound' | 'telegram.forum_unbound' | 'telegram.forum_failed',
    chatId: number,
    reason: string | null,
    actor: 'boris' | 'system' = 'boris',
  ) {
    await appendEvent(d.db, {
      type,
      v: 1,
      entity: { kind: 'telegram_chat', id: String(chatId) },
      account_id: null,
      actor,
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason,
      payload: {},
    })
  }

  /** A word to Boris's own chat, whatever the forum does; a refusal is only logged. */
  async function toOwnChat(text: string): Promise<void> {
    const own = await boundChat(d.db)
    if (own !== null)
      await bot.api
        .sendMessage(own, text)
        .catch((e: unknown) => console.error('own chat', short(e)))
  }

  // docs/product/telegram-forum.md: Boris's group with topics becomes where his messages go.
  bot.command('forum', async (ctx) => {
    const c = ctx.chat
    if (c.type === 'private') return void (await ctx.reply(TEXTS.forumHowTo))
    if (c.type !== 'supergroup' || !c.is_forum) return void (await ctx.reply(TEXTS.forumNotForum))
    const me = await ctx.api.getChatMember(c.id, ctx.me.id).catch(() => null)
    if (me?.status !== 'administrator' || !me.can_manage_topics)
      return void (await ctx.reply(TEXTS.forumNoRights))
    const same = await forumOf(d.db)
    const leads =
      same?.chatId === c.id && same.leadsThreadId !== null
        ? same.leadsThreadId
        : (await ctx.api.createForumTopic(c.id, TEXTS.leadsTopic).catch(() => null))
            ?.message_thread_id
    if (leads === undefined) return void (await ctx.reply(TEXTS.forumNoRights))
    await bindForum(d.db, { chatId: c.id, title: c.title, leadsThreadId: leads })
    await journal('telegram.forum_bound', c.id, null)
    await ctx.reply(TEXTS.forumBound)
    await toOwnChat(TEXTS.forumMoved(c.title))
  })

  bot.command('forum_off', async (ctx) => {
    const f = await forumOf(d.db)
    if (!f) return void (await ctx.reply(TEXTS.forumNone))
    await unbindForum(d.db)
    await journal('telegram.forum_unbound', f.chatId, 'unbound by Boris')
    await ctx.reply(TEXTS.forumOff)
    if (ctx.chat.type !== 'private') await toOwnChat(TEXTS.forumOff)
  })

  /**
   * A command's answer. A page opens as the Mini App in Boris's chat (Telegram takes only https there) and as a link in
   * a group; should Telegram refuse the button, the address goes as text.
   */
  async function answerCommand(ctx: Context, r: CommandReply): Promise<void> {
    if (typeof r === 'string') return void (await ctx.reply(r))
    const { text, url } = r.open
    const app = ctx.chat?.type === 'private' && url.startsWith('https://')
    await ctx
      .reply(r.text, {
        reply_markup: { inline_keyboard: [[app ? { text, web_app: { url } } : { text, url }]] },
      })
      .catch(async (e: unknown) => {
        console.error('command button refused', short(e))
        await ctx.reply(`${r.text}\n${url}`, { link_preview_options: { is_disabled: true } })
      })
  }

  // The menu's commands (Boris, 30.10.2026); the forum's two above need Telegram itself.
  for (const c of COMMANDS) {
    const run = c.run
    if (!run) continue
    bot.command(c.name, async (ctx) => {
      let r: CommandReply
      try {
        r = await run({ db: d.db, publicUrl: d.publicUrl ?? null })
      } catch (e) {
        console.error(`/${c.name} failed`, short(e))
        r = TEXTS.commandFailed
      }
      await answerCommand(ctx, r)
    })
  }

  /** The list of commands under the menu button, in Boris's chat and in his forum; a refusal is only logged. */
  async function publishMenu(): Promise<void> {
    const log = (what: string) => (e: unknown) => console.error(what, short(e))
    await bot.api
      .setMyCommands(COMMANDS.map((c) => ({ command: c.name, description: c.description })))
      .catch(log('commands not set'))
    await bot.api
      .setChatMenuButton({ menu_button: { type: 'commands' } })
      .catch(log('menu button not set'))
    // A button set for his chat alone (the Mini App once) would hide the list: his chat gets the list too.
    const own = await boundChat(d.db)
    if (own !== null)
      await bot.api
        .setChatMenuButton({ chat_id: own, menu_button: { type: 'commands' } })
        .catch(log('menu button of the chat not set'))
  }

  bot.on('my_chat_member', async (ctx) => {
    const f = await forumOf(d.db)
    const status = ctx.myChatMember.new_chat_member.status
    if (f?.chatId !== ctx.chat.id || (status !== 'left' && status !== 'kicked')) return
    await unbindForum(d.db)
    await journal('telegram.forum_unbound', f.chatId, `bot ${status}`, 'system')
    await toOwnChat(TEXTS.forumLost)
  })

  /**
   * What a message of Boris's is to the core. In the forum: its post's number (so it never meets a number of his own
   * chat), the post it replies to, and the client of the topic it is in.
   */
  async function heard(
    msg: Message,
  ): Promise<Pick<BorisMessage, 'messageId' | 'replyToMessageId' | 'client'>> {
    const f = msg.chat.type === 'private' ? null : await forumOf(d.db)
    if (!f || msg.chat.id !== f.chatId)
      return {
        messageId: msg.message_id,
        replyToMessageId: msg.reply_to_message?.message_id ?? null,
      }
    const thread = msg.is_topic_message ? (msg.message_thread_id ?? null) : null
    // In a topic a message that replies to nothing points at the topic's first service message.
    const r = msg.reply_to_message
    const replied = r && r.message_id !== thread && !r.forum_topic_created ? r.message_id : null
    const topic =
      thread !== null && thread !== f.leadsThreadId
        ? await topicByThread(d.db, f.chatId, thread)
        : null
    return {
      messageId: await postRef(d.db, f.chatId, msg.message_id, thread),
      replyToMessageId: replied === null ? null : await postRef(d.db, f.chatId, replied, thread),
      ...(topic && {
        client: {
          conversationId: await conversationOfTopic(d.db, topic),
          orderId: topic.key.startsWith('conv:') ? null : topic.key,
        },
      }),
    }
  }

  /** An answer to Boris's message: a line, with its buttons when it has some. */
  const answer = (ctx: Context, r: BorisReply) =>
    typeof r === 'string'
      ? ctx.reply(r)
      : ctx.reply(r.text, { reply_markup: { inline_keyboard: keyboard(r.rows) } })

  bot.on('message:text', async (ctx) => {
    if (!d.onMessage || ctx.message.text.startsWith('/')) return
    await answer(
      ctx,
      await d.onMessage({
        text: ctx.message.text,
        voicePath: null,
        ...(await heard(ctx.message)),
        at: new Date(),
      }),
    )
  })

  bot.on('message:voice', (ctx) => {
    const onMessage = d.onMessage
    if (!onMessage) return
    const fileId = ctx.message.voice.file_id
    const msg = ctx.message
    // Recognition takes seconds: it runs on its own, so the bot keeps answering presses meanwhile.
    void (async () => {
      const base = d.voiceDir ?? tmpdir()
      await mkdir(base, { recursive: true })
      const dir = await mkdtemp(join(base, 'voice-'))
      try {
        const file = await ctx.api.getFile(fileId)
        const res = await fetch(
          `${d.apiRoot ?? 'https://api.telegram.org'}/file/bot${d.token}/${file.file_path}`,
          { signal: AbortSignal.timeout(60_000) },
        )
        if (!res.ok || !file.file_path) throw new Error(`voice download: ${res.status}`)
        const path = join(dir, 'voice.oga')
        await writeFile(path, Buffer.from(await res.arrayBuffer()))
        await answer(
          ctx,
          await onMessage({
            text: null,
            voicePath: path,
            ...(await heard(msg)),
            at: new Date(),
          }),
        )
      } catch (e) {
        console.error('voice message failed', e instanceof Error ? e.message : e)
        await ctx.reply(TEXTS.voiceFailed).catch(() => {})
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })()
  })

  bot.on('callback_query:data', async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data)
    if (!parsed) return ctx.answerCallbackQuery()
    const text = await d.onPress(parsed)
    await ctx.answerCallbackQuery({ text })
  })

  bot.catch((err) => {
    console.error('telegram update failed', err.error)
  })

  async function chat(): Promise<number> {
    const id = await boundChat(d.db)
    if (id === null) throw new Error('Telegram chat is not bound yet')
    return id
  }

  /**
   * A message of Telegram HTML without link previews (the order page needs a login, so a preview is empty). Should
   * Telegram refuse the markup, the same message goes as plain text: a card is never lost to a formatting error.
   */
  async function sendHtml(to: number, html: string, extra: Omit<SendOptions, 'parse_mode'>) {
    try {
      return await bot.api.sendMessage(to, html, {
        ...extra,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
    } catch (err) {
      if (!(err instanceof GrammyError) || !/can't parse entities/i.test(err.description)) throw err
      console.error('telegram refused the markup, sending plain text:', err.description)
      return bot.api.sendMessage(to, plainFallback(html), {
        ...extra,
        link_preview_options: { is_disabled: true },
      })
    }
  }

  /** The chat and the Telegram number of a message the core knows by `ref`: a forum post when negative. */
  async function locate(ref: number): Promise<{ to: number; id: number } | null> {
    if (ref > 0) return { to: await chat(), id: ref }
    const p = await postOf(d.db, ref)
    return p ? { to: p.chatId, id: p.messageId } : null
  }

  /** Topics being made or opened, one at a time per client, so two messages at once never make two topics. */
  const topicQueue = new Map<string, Promise<unknown>>()
  function inTurn<T>(key: string, job: () => Promise<T>): Promise<T> {
    const run = (topicQueue.get(key) ?? Promise.resolve()).catch(() => {}).then(job)
    topicQueue.set(key, run)
    void run
      .finally(() => {
        if (topicQueue.get(key) === run) topicQueue.delete(key)
      })
      .catch(() => {})
    return run
  }

  const logTopic = (what: string) => (e: unknown) => {
    // An open topic opened again, or a name that is already this one, is not a failure.
    if (!/TOPIC_NOT_MODIFIED|not modified/i.test(short(e))) console.error(what, short(e))
  }

  /**
   * The client's topic in the forum, made on its first message with the order as its first post, and opened again
   * when it was closed: something new came for this client.
   */
  function clientTopic(chatId: number, k: { key: string; conversationId: string | null }) {
    return inTurn(`${chatId}:${k.key}`, async () => {
      const t = await topicByKey(d.db, chatId, k.key)
      if (t) {
        if (k.conversationId && !t.conversationId)
          await linkTopic(d.db, chatId, k.key, k.conversationId)
        if (t.closedAt) {
          await bot.api.reopenForumTopic(chatId, t.threadId).catch(logTopic('topic not reopened'))
          await bot.api
            .editForumTopic(chatId, t.threadId, { name: t.name })
            .catch(logTopic('topic not renamed'))
          await markTopic(d.db, chatId, k.key, null)
        }
        return t.threadId
      }
      const { name, intro } = await topicIntro(d.db, k.key)
      const made = await bot.api.createForumTopic(chatId, name)
      const thread = made.message_thread_id
      await saveTopic(d.db, {
        chatId,
        key: k.key,
        threadId: thread,
        conversationId: k.conversationId,
        name,
      })
      const m = await bot.api.sendMessage(chatId, intro, {
        message_thread_id: thread,
        link_preview_options: { is_disabled: true },
        disable_notification: true,
      })
      await postRef(d.db, chatId, m.message_id, thread)
      return thread
    })
  }

  type Spot = { to: number; thread?: number; forum: boolean; key?: string }

  /** Where a place is now: Boris's chat without a forum; its topic with one (General when a topic cannot be made). */
  async function spot(place: Place | undefined): Promise<Spot> {
    const f = await forumOf(d.db)
    if (!f) return { to: await chat(), forum: false }
    if (place === 'leads')
      return { to: f.chatId, thread: f.leadsThreadId ?? undefined, forum: true }
    const k = isClientPlace(place) ? await topicKey(d.db, place) : null
    if (!k) return { to: f.chatId, forum: true }
    try {
      return { to: f.chatId, thread: await clientTopic(f.chatId, k), forum: true, key: k.key }
    } catch (err) {
      if (forumRefused(err)) throw err
      console.error('client topic not made, the general one takes it', short(err))
      return { to: f.chatId, forum: true }
    }
  }

  /**
   * «Заявки» deleted or closed by hand: closed, it is opened; deleted, a new one is made; neither possible, the cards
   * go to the general topic. A card is never lost to a topic.
   */
  async function leadsAgain(f: Forum, gone: boolean): Promise<number | undefined> {
    if (!gone && f.leadsThreadId !== null) {
      const opened = await bot.api.reopenForumTopic(f.chatId, f.leadsThreadId).then(
        () => true,
        (e: unknown) => /TOPIC_NOT_MODIFIED/i.test(short(e)),
      )
      if (opened) return f.leadsThreadId
    }
    const made = await bot.api.createForumTopic(f.chatId, TEXTS.leadsTopic).catch(() => null)
    await bindForum(d.db, { ...f, leadsThreadId: made?.message_thread_id ?? null })
    return made?.message_thread_id
  }

  let forumFailedAt = 0
  /** The forum refused a message: logged at most once an hour, the message itself goes to Boris's chat. */
  async function forumFailed(err: unknown): Promise<void> {
    console.error('the forum refused a message, it goes to the own chat', short(err))
    if (Date.now() - forumFailedAt < 3600_000) return
    forumFailedAt = Date.now()
    const f = await forumOf(d.db)
    if (f) await journal('telegram.forum_failed', f.chatId, short(err), 'system').catch(() => {})
  }

  /**
   * A message to a place; the core knows it by the returned number (a forum post's is negative). A topic deleted or
   * closed by hand is made or opened again once; a forum that refuses the bot altogether gives way to Boris's own
   * chat, so a message is never lost to the forum.
   */
  async function post(
    place: Place | undefined,
    send: (to: number, where: { message_thread_id?: number }) => Promise<Message>,
  ): Promise<number> {
    const where = (s: Spot) => (s.thread === undefined ? {} : { message_thread_id: s.thread })
    try {
      let s = await spot(place)
      if (!s.forum) return (await send(s.to, {})).message_id
      let m: Message
      try {
        m = await send(s.to, where(s))
      } catch (err) {
        const why = err instanceof GrammyError ? err.description : ''
        const f = await forumOf(d.db)
        const gone = TOPIC_GONE.test(why)
        if (!f || s.thread === undefined || !(gone || TOPIC_CLOSED.test(why))) throw err
        if (s.key) {
          if (gone) await dropTopic(d.db, f.chatId, s.key)
          else await markTopic(d.db, f.chatId, s.key, new Date().toISOString())
          s = await spot(place)
        } else s = { to: f.chatId, thread: await leadsAgain(f, gone), forum: true }
        m = await send(s.to, where(s))
      }
      return await postRef(d.db, s.to, m.message_id, s.thread ?? null)
    } catch (err) {
      if (!forumRefused(err) || !(await forumOf(d.db))) throw err
      await forumFailed(err)
      return (await send(await chat(), {})).message_id
    }
  }

  /**
   * A message of Telegram HTML edited in place, with the buttons taken away. As for a send, markup Telegram refuses
   * goes as plain text. Any other refusal (the message was deleted, or already shows this) is logged, never thrown:
   * one message that cannot be edited must not stop the others.
   */
  async function closeHtml(ref: number, html: string): Promise<void> {
    const at = await locate(ref)
    if (!at) return void console.error('telegram did not edit the closed card: unknown', ref)
    const { to, id: messageId } = at
    const opts = {
      reply_markup: { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    }
    try {
      await bot.api.editMessageText(to, messageId, html, { ...opts, parse_mode: 'HTML' })
    } catch (err) {
      try {
        if (!(err instanceof GrammyError) || !/can't parse entities/i.test(err.description))
          throw err
        await bot.api.editMessageText(to, messageId, plainFallback(html), opts)
      } catch (e) {
        console.error('telegram did not edit the closed card', ref, short(e))
      }
    }
  }

  /** FR-NOTIF-2: without sound at the quiet hours, unless the message is urgent. */
  const silentNow = async (loud?: boolean) => !loud && (await quietNow(d.db, new Date()))

  let running: Promise<void> | null = null
  let lastError: string | null = null

  function explain(err: unknown): string {
    const code = (err as { error_code?: number }).error_code
    if (code === 409) {
      return 'Этого бота уже читает другая программа (например, старая Сара). Создай отдельного бота или останови другую программу.'
    }
    if (code === 401)
      return 'Telegram больше не принимает токен бота. Выпусти новый у @BotFather и вставь его в мастере.'
    return `Бот перестал получать сообщения: ${err instanceof Error ? err.message : String(err)}`
  }

  return {
    async start() {
      await bot.init()
      lastError = null
      await publishMenu()
      await new Promise<void>((ready, fail) => {
        // Polling errors must never become an unhandled rejection: that would stop the whole core.
        running = bot.start({ onStart: () => ready() }).catch(async (err) => {
          lastError = explain(err)
          fail(err)
          await appendEvent(d.db, {
            type: 'health.check_failed',
            v: 1,
            entity: { kind: 'telegram_bot', id: bot.botInfo.username },
            account_id: null,
            actor: 'system',
            occurred_at: new Date().toISOString(),
            causation_id: null,
            correlation_id: newEventId(),
            reason: lastError,
            payload: { error_code: (err as { error_code?: number }).error_code ?? null },
          }).catch(() => {})
        })
      })
    },
    async stop() {
      if (bot.isRunning()) await bot.stop()
      await running
    },
    lastError: () => lastError,
    botUsername: () => (bot.isInited() ? bot.botInfo.username : null),
    notifier: {
      async sendLeadCard(c, o) {
        const silent = o?.silent ?? (await silentNow())
        const messageId = await post('leads', (to, where) =>
          sendHtml(to, leadCardText(c), {
            ...where,
            reply_markup: leadCardKeyboard(c),
            ...(silent && { disable_notification: true }),
          }),
        )
        return { messageId }
      },
      async closeLeadCard(messageId, c) {
        await closeHtml(messageId, closedLeadCardText(c))
      },
      async sendText(text, o) {
        const silent = await silentNow(o?.loud)
        const extra: Omit<SendOptions, 'parse_mode'> = silent ? { disable_notification: true } : {}
        const messageId = await post(o?.place, (to, where) =>
          o?.html
            ? sendHtml(to, text, { ...where, ...extra })
            : bot.api.sendMessage(to, text, { ...where, ...extra }),
        )
        return { messageId }
      },
      async sendButtons(text, rows, o) {
        const silent = await silentNow(o?.loud)
        const messageId = await post(o?.place, (to, where) =>
          bot.api.sendMessage(to, text, {
            ...where,
            ...(silent && { disable_notification: true }),
            reply_markup: { inline_keyboard: keyboard(rows) },
          }),
        )
        return { messageId }
      },
      async markDone(ref, note) {
        const at = await locate(ref)
        if (!at) return void console.error('card not marked: unknown', ref)
        // One button that decides nothing: its press gets an empty answer (no task in its data).
        await bot.api
          .editMessageReplyMarkup(at.to, at.id, {
            reply_markup: { inline_keyboard: [[{ text: note, callback_data: 'done' }]] },
          })
          .catch((e: unknown) => console.error('card not marked', short(e)))
      },
      async editText(ref, text, rows) {
        const at = await locate(ref)
        if (!at) return void console.error('message not edited: unknown', ref)
        await bot.api
          .editMessageText(at.to, at.id, text, {
            ...(rows && { reply_markup: { inline_keyboard: keyboard(rows) } }),
          })
          .catch((e: unknown) => {
            // The same text again is not an error worth a retry.
            if (!String((e as Error).message).includes('message is not modified')) throw e
          })
      },
      async closeTopic(place, outcome) {
        try {
          const f = await forumOf(d.db)
          const k = f ? await topicKey(d.db, place) : null
          const t = f && k ? await topicByKey(d.db, f.chatId, k.key) : null
          if (!f || !k || !t || t.closedAt) return
          const m = await bot.api.sendMessage(f.chatId, outcome, {
            message_thread_id: t.threadId,
            disable_notification: true,
          })
          await postRef(d.db, f.chatId, m.message_id, t.threadId)
          await bot.api
            .editForumTopic(f.chatId, t.threadId, { name: `${t.name}${CLOSED_MARK}` })
            .catch(logTopic('topic not renamed'))
          await bot.api.closeForumTopic(f.chatId, t.threadId).catch(logTopic('topic not closed'))
          await markTopic(d.db, f.chatId, k.key, new Date().toISOString())
        } catch (e) {
          console.error('topic not closed', short(e))
        }
      },
    },
  }
}
