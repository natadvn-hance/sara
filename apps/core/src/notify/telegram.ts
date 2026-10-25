import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newEventId, parseCallback, type TaskAction } from '@sara/shared'
import { Bot, type Context, GrammyError } from 'grammy'
import type { Db } from '../db/client'
import { appendEvent } from '../journal/journal'
import { quietNow } from '../leads/cardFlow'
import type { BorisMessage } from '../learning/inbox'
import { bindChat, boundChat } from './binding'
import { leadCardKeyboard, leadCardText, plainFallback, TEXTS } from './cards'
import type { Notifier } from './notifier'

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

/** The bot obeys only the chat bound by the first /start (threat model T9). */
export function createTelegramRuntime(d: {
  token: string
  apiRoot?: string
  db: Db
  onPress(p: { taskId: string; action: TaskAction }): Promise<string>
  /** Boris's text or voice (saved to a file first); the answer goes back to him. */
  onMessage?(m: BorisMessage): Promise<string>
  /** Where voice messages are saved while they are recognized (default: the system temp folder). */
  voiceDir?: string
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

  bot.on('message:text', async (ctx) => {
    if (!d.onMessage || ctx.message.text.startsWith('/')) return
    await ctx.reply(
      await d.onMessage({
        text: ctx.message.text,
        voicePath: null,
        replyToMessageId: ctx.message.reply_to_message?.message_id ?? null,
        at: new Date(),
      }),
    )
  })

  bot.on('message:voice', (ctx) => {
    const onMessage = d.onMessage
    if (!onMessage) return
    const fileId = ctx.message.voice.file_id
    const replyTo = ctx.message.reply_to_message?.message_id ?? null
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
        await ctx.reply(
          await onMessage({
            text: null,
            voicePath: path,
            replyToMessageId: replyTo,
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
  async function sendHtml(html: string, extra: Omit<SendOptions, 'parse_mode'>) {
    const to = await chat()
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
        const m = await sendHtml(leadCardText(c), {
          reply_markup: leadCardKeyboard(c),
          ...(silent && { disable_notification: true }),
        })
        return { messageId: m.message_id }
      },
      async sendText(text, o) {
        const silent = await silentNow(o?.loud)
        const extra: Omit<SendOptions, 'parse_mode'> = silent ? { disable_notification: true } : {}
        const m = o?.html
          ? await sendHtml(text, extra)
          : await bot.api.sendMessage(await chat(), text, extra)
        return { messageId: m.message_id }
      },
      async sendButtons(text, rows, o) {
        const m = await bot.api.sendMessage(await chat(), text, {
          ...((await silentNow(o?.loud)) && { disable_notification: true }),
          reply_markup: {
            inline_keyboard: rows.map((r) =>
              r.map((b) => ({ text: b.text, callback_data: b.callbackData })),
            ),
          },
        })
        return { messageId: m.message_id }
      },
      async editText(messageId, text, rows) {
        await bot.api.editMessageText(await chat(), messageId, text, {
          reply_markup: {
            inline_keyboard: (rows ?? []).map((r) =>
              r.map((b) => ({ text: b.text, callback_data: b.callbackData })),
            ),
          },
        })
      },
    },
  }
}
