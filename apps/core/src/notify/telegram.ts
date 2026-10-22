import { newEventId, parseCallback, type TaskAction } from '@sara/shared'
import { Bot, type Context } from 'grammy'
import type { Db } from '../db/client'
import { appendEvent } from '../journal/journal'
import { bindChat, boundChat } from './binding'
import { leadCardKeyboard, leadCardText, TEXTS } from './cards'
import type { Notifier } from './notifier'

export type TelegramRuntime = {
  start(): Promise<void>
  stop(): Promise<void>
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

  return {
    async start() {
      await bot.init()
      await new Promise<void>((ready) => {
        running = bot.start({ onStart: () => ready() })
      })
    },
    async stop() {
      if (bot.isRunning()) await bot.stop()
      await running
    },
    botUsername: () => (bot.isInited() ? bot.botInfo.username : null),
    notifier: {
      async sendLeadCard(c) {
        const m = await bot.api.sendMessage(await chat(), leadCardText(c), {
          reply_markup: leadCardKeyboard(c),
        })
        return { messageId: m.message_id }
      },
      async sendText(text) {
        await bot.api.sendMessage(await chat(), text)
      },
    },
  }
}
