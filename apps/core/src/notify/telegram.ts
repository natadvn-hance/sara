import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newEventId, parseCallback, type TaskAction } from '@sara/shared'
import { Bot, type Context } from 'grammy'
import type { Db } from '../db/client'
import { appendEvent } from '../journal/journal'
import type { BorisMessage } from '../learning/inbox'
import { bindChat, boundChat } from './binding'
import { leadCardKeyboard, leadCardText, TEXTS } from './cards'
import type { Notifier } from './notifier'

export type TelegramRuntime = {
  start(): Promise<void>
  stop(): Promise<void>
  /** Why polling stopped by itself (revoked token, another program on the same bot), in plain words. */
  lastError(): string | null
  botUsername(): string | null
  notifier: Notifier
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
      async sendLeadCard(c) {
        const m = await bot.api.sendMessage(await chat(), leadCardText(c), {
          reply_markup: leadCardKeyboard(c),
        })
        return { messageId: m.message_id }
      },
      async sendText(text) {
        const m = await bot.api.sendMessage(await chat(), text)
        return { messageId: m.message_id }
      },
      async sendButtons(text, rows) {
        const m = await bot.api.sendMessage(await chat(), text, {
          reply_markup: {
            inline_keyboard: rows.map((r) =>
              r.map((b) => ({ text: b.text, callback_data: b.callbackData })),
            ),
          },
        })
        return { messageId: m.message_id }
      },
    },
  }
}
