import { formatCallback, SETTINGS, type SystemView, type TaskAction } from '@sara/shared'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  COMMAND_TEXTS,
  type CommandDeps,
  close,
  giveBack,
  proposeSay,
  take,
} from '../conversation/commands'
import { CONV_TEXTS } from '../conversation/texts'
import type { Db } from '../db/client'
import { conversation, convTurn, task } from '../db/schema'
import { type Redactor, restore } from '../gateway/redact'
import type { BorisReply } from '../learning/inbox'
import type { QuestionRow } from '../learning/questions'
import type { Notifier } from '../notify/notifier'
import { analyticsView } from '../pult/analytics'
import { conversationList, conversationView } from '../pult/conversations'
import { leadQueue, leadView, orderUrl } from '../pult/leads'
import { PULT_TEXTS } from '../pult/routes'
import { pultMay, SETTING_META, settingsView } from '../pult/settings'
import { todayView } from '../pult/today'
import { getSetting, setSetting } from '../settings/store'

/** What the Secretary's tools act with: the same functions as the buttons and the pult (ADR-027). */
export type SecretaryDeps = {
  db: Db
  notifier: Pick<Notifier, 'sendButtons'>
  /** The press of a Telegram button. */
  onPress(p: { taskId: string; action: TaskAction }): Promise<string>
  /** The bid text and price on a lead's card, as the pult saves them. */
  saveBidText(p: {
    taskId: string
    text: string | null
    priceRub: number | null
  }): Promise<{ saved: boolean; message: string }>
  /** The commands of a conversation card (M4). */
  commands: CommandDeps
  /** Boris's words as the answer to Sara's open question: the same path as a reply to it. */
  answerQuestion(
    q: QuestionRow,
    a: { text: string; voice: boolean; messageId?: number; at: Date },
  ): Promise<BorisReply>
  /** The health screen. */
  system(): Promise<SystemView>
}

/** One turn as its tools see it. */
export type TurnContext = {
  /** The turn's hiding (ADR-016): answers go out through it, arguments come back through it. */
  redactor: Redactor
  /** Boris's words of this turn, exactly as he wrote them: an answer to a question is these, never the model's. */
  said: { text: string; voice: boolean; messageId?: number; at: Date }
  /** The open questions shown this turn: only these may be answered. */
  questions: QuestionRow[]
  /** The tools this turn called, for the journal. */
  used: string[]
}

type Tool<I extends z.ZodObject> = {
  description: string
  input: I
  run(d: SecretaryDeps, t: TurnContext, input: z.infer<I>): Promise<unknown>
}

const tool = <I extends z.ZodObject>(t: Tool<I>) => t

/** An action's outcome for the model: whether it happened and Boris's words for it. */
const done = (ok: boolean, message: string) => ({ ok, message })

const TOOL_TEXTS = {
  noLead: 'Такой заявки нет. Проверь номер заказа.',
  noTask: 'Такой задачи нет: возьми taskId из leads или lead.',
  notWaiting: 'Эта заявка уже решена или не ждёт решения.',
  noConversation: 'Такого разговора нет: возьми id из conversations.',
  noCard:
    'У этого клиента сейчас нет открытой карточки. Свой текст без карточки можно отправить из пульта («Свой текст») или самому на Профи.ру.',
  noDraft: 'У этого клиента нет черновика, который ждёт отправки.',
  notAsked: 'Этот вопрос не открыт в этом ходе.',
  bidOffered: (fee: number) =>
    `Прислала Борису кнопку «Откликнуться${fee > 0 ? ` за ${fee} ₽` : ''}». Деньги уйдут только по его нажатию.`,
  sayOffered: 'Показала Борису слова с кнопкой «Отправить». Клиенту уйдёт только по его нажатию.',
  draftOffered: 'Прислала Борису черновик с кнопкой «Отправить».',
  saved: (title: string, value: unknown) =>
    `Сохранила: «${title}» теперь ${JSON.stringify(value)}.`,
  bidQuestion: (title: string, fee: number, url: string) =>
    `Откликнуться на «${title}»${fee > 0 ? ` за ${fee} ₽` : ''}?\n${url}`,
  draftCard: (name: string, text: string) => `Черновик для ${name}:\n\n${text}`,
} as const

const uuid = z.uuid()

async function openLeadTask(db: Db, taskId: string) {
  if (!uuid.safeParse(taskId).success) return null
  const [t] = await db.select().from(task).where(eq(task.id, taskId))
  return t ?? null
}

async function hasConversation(db: Db, id: string): Promise<boolean> {
  if (!uuid.safeParse(id).success) return false
  const [c] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.id, id))
  return c !== undefined
}

/** The open card of a conversation (a reply or a reminder) and its turn, newest first. */
async function openCard(db: Db, conversationId: string) {
  const [row] = await db
    .select({ task, turn: convTurn })
    .from(task)
    .innerJoin(convTurn, eq(task.entityId, convTurn.id))
    .where(
      and(
        eq(task.kind, 'conv_draft'),
        eq(task.state, 'open'),
        eq(convTurn.conversationId, conversationId),
      ),
    )
    .orderBy(desc(task.createdAt))
    .limit(1)
  return row ?? null
}

/** The words of a reply that came with buttons go to Boris with them; the tool hears the words. */
async function relay(d: SecretaryDeps, r: BorisReply): Promise<string> {
  if (typeof r === 'string') return r
  await d.notifier.sendButtons(r.text, r.rows)
  return r.text
}

/**
 * The Secretary's tools (ADR-027). Reading: the pult's own views. Acting: the functions of the buttons. Nothing here
 * spends money or writes to a client: those tools send Boris the button that does, and only his press does it.
 */
export const SECRETARY_TOOLS = {
  today: tool({
    description:
      'Сводка дня: что ждёт Бориса, кошелёк, отклики и траты сегодня против лимитов, что я делаю, последние шаги, итоги за 7 дней.',
    input: z.object({}),
    run: (d) => todayView(d.db, 7),
  }),
  leads: tool({
    description:
      'Очередь заявок, ждущих решения Бориса (номер заказа id, taskId для действий, балл, цена отклика feeRub, ссылка url), недавно решённые и пауза откликов.',
    input: z.object({}),
    run: async (d) => {
      const q = await leadQueue(d.db)
      return {
        ...q,
        queue: q.queue.map((r) => ({ ...r, url: orderUrl(r.id) })),
        decided: q.decided.map((r) => ({ ...r, url: orderUrl(r.id) })),
      }
    },
  }),
  lead: tool({
    description:
      'Заявка целиком по номеру заказа: текст, клиент, балл и почему (порог, стоп-фактор), разбор, текст отклика и цена, задача (task.id для действий), что мешает откликнуться, ссылка url.',
    input: z.object({ orderId: z.string().min(1).describe('номер заказа Профи.ру') }),
    run: async (d, _t, i) =>
      (await leadView(d.db, i.orderId.trim())) ?? done(false, TOOL_TEXTS.noLead),
  }),
  conversations: tool({
    description:
      'Разговоры с клиентами по группам: waiting (ждут Бориса), boris (ведёт Борис), sara (веду я), closed. У каждого id, имя, заказ, последнее сообщение.',
    input: z.object({}),
    run: (d) => conversationList(d.db),
  }),
  conversation: tool({
    description:
      'Один разговор по id: кто ведёт, переписка, черновик ответа (taskId, текст, почему), ссылка на чат chatUrl, что мешает отправке.',
    input: z.object({ id: z.string().describe('id разговора из conversations') }),
    run: async (d, _t, i) =>
      uuid.safeParse(i.id).success
        ? ((await conversationView(d.db, i.id)) ?? done(false, TOOL_TEXTS.noConversation))
        : done(false, TOOL_TEXTS.noConversation),
  }),
  settings: tool({
    description:
      'Настройки по группам: ключ key, значение, можно ли менять (edit: free, stop_only, locked).',
    input: z.object({}),
    run: (d) => settingsView(d.db),
  }),
  health: tool({
    description: 'Состояние системы: Профи.ру, Claude и его лимит, Telegram, копии базы.',
    input: z.object({}),
    run: (d) => d.system(),
  }),
  analytics: tool({
    description: 'Аналитика за год: клиенты по месяцам, воронка, месяцы (отклики, выигрыши).',
    input: z.object({ year: z.number().int().min(2020).max(2100).optional() }),
    run: (d, _t, i) => analyticsView(d.db, i.year ?? new Date().getFullYear()),
  }),

  set_setting: tool({
    description:
      'Поменять настройку, как в пульте. Лимиты (money.*, cards.*, conv.cards_per_day, secretary.turns_per_day) свободно. outbound.bids, outbound.messages, conv.autopilot, conv.reminders только выключить (false). Остальное нельзя.',
    input: z.object({ key: z.string(), value: z.unknown() }),
    run: async (d, _t, i) => {
      if (!(i.key in SETTINGS) || !pultMay(i.key, i.value)) return done(false, PULT_TEXTS.locked)
      const parsed = SETTINGS[i.key].schema.safeParse(i.value)
      if (!parsed.success) return done(false, PULT_TEXTS.badValue)
      await setSetting(d.db, i.key, parsed.data as never, 'boris')
      return done(true, TOOL_TEXTS.saved(SETTING_META[i.key]?.title ?? i.key, parsed.data))
    },
  }),
  skip_lead: tool({
    description:
      'Пропустить заявку из очереди (как кнопка «Пропустить»). taskId из leads или lead.',
    input: z.object({ taskId: z.string() }),
    run: async (d, _t, i) => {
      const t = await openLeadTask(d.db, i.taskId)
      if (!t) return done(false, TOOL_TEXTS.noTask)
      if (t.kind !== 'lead_decision' || t.state !== 'open')
        return done(false, TOOL_TEXTS.notWaiting)
      return done(true, await d.onPress({ taskId: t.id, action: 'skip' }))
    },
  }),
  offer_bid: tool({
    description:
      'Прислать Борису кнопку «Откликнуться за N ₽» по заявке. Сама я не откликаюсь и деньги не трачу: отклик уйдёт только по его нажатию. Только по прямой просьбе Бориса про эту заявку.',
    input: z.object({ taskId: z.string() }),
    run: async (d, _t, i) => {
      const t = await openLeadTask(d.db, i.taskId)
      if (!t) return done(false, TOOL_TEXTS.noTask)
      if (t.kind !== 'lead_decision' || t.state !== 'open')
        return done(false, TOOL_TEXTS.notWaiting)
      const v = await leadView(d.db, t.entityId)
      if (!v) return done(false, TOOL_TEXTS.noLead)
      const fee = v.lead.feeRub
      await d.notifier.sendButtons(TOOL_TEXTS.bidQuestion(v.lead.title, fee, v.lead.url), [
        [
          {
            text: fee > 0 ? `Откликнуться за ${fee} ₽` : 'Откликнуться',
            callbackData: formatCallback(t.id, 'bid'),
          },
        ],
      ])
      return { ...done(true, TOOL_TEXTS.bidOffered(fee)), obstacles: v.obstacles }
    },
  }),
  set_bid_text: tool({
    description:
      'Сохранить на карточке заявки новый текст отклика и или «Стоимость услуги» в рублях (priceRub). Только после «да» Бориса на этот текст. Отклик не отправляет.',
    input: z.object({
      taskId: z.string(),
      text: z.string().min(1).optional(),
      priceRub: z.number().int().positive().optional(),
    }),
    run: async (d, _t, i) => {
      if (i.text === undefined && i.priceRub === undefined)
        return done(false, 'Нужен текст или цена.')
      if (!(await openLeadTask(d.db, i.taskId))) return done(false, TOOL_TEXTS.noTask)
      const r = await d.saveBidText({
        taskId: i.taskId,
        text: i.text ?? null,
        priceRub: i.priceRub ?? null,
      })
      return done(r.saved, r.message)
    },
  }),
  client_action: tool({
    description:
      'Команда по разговору с клиентом: take («беру сам»: Борис ведёт, я не пишу), return («верни Саре», note: его указание, как вести дальше), close («закрой»: не пишу и не напоминаю).',
    input: z.object({
      conversationId: z.string(),
      action: z.enum(['take', 'return', 'close']),
      note: z.string().optional(),
    }),
    run: async (d, _t, i) => {
      if (!(await hasConversation(d.db, i.conversationId)))
        return done(false, TOOL_TEXTS.noConversation)
      if (i.action === 'take') {
        await take(d.db, i.conversationId)
        return done(true, COMMAND_TEXTS.taken)
      }
      if (i.action === 'return') {
        await giveBack(d.db, i.conversationId, i.note?.trim() || null)
        return done(true, COMMAND_TEXTS.returned)
      }
      await close(d.db, i.conversationId)
      return done(true, COMMAND_TEXTS.closed)
    },
  }),
  offer_client_text: tool({
    description:
      'Показать Борису слова для клиента с кнопкой «Отправить»: клиенту уйдёт только по его нажатию. Его собственные слова дословно; свой вариант только после его «да».',
    input: z.object({ conversationId: z.string(), text: z.string().min(1) }),
    run: async (d, _t, i) => {
      if (!(await hasConversation(d.db, i.conversationId)))
        return done(false, TOOL_TEXTS.noConversation)
      if (await getSetting(d.db, 'conv.v1_writes')) return done(false, COMMAND_TEXTS.shadowSay)
      const card = await openCard(d.db, i.conversationId)
      if (!card) return done(false, TOOL_TEXTS.noCard)
      const r = await proposeSay(d.commands, card.turn, i.text.trim(), { via: 'say' })
      if (typeof r === 'string') return done(false, r)
      await d.notifier.sendButtons(r.text, r.rows)
      return done(true, TOOL_TEXTS.sayOffered)
    },
  }),
  offer_draft: tool({
    description:
      'Прислать Борису мой черновик ответа клиенту с кнопкой «Отправить» (когда он говорит «отправляй черновик ...»). Сама не отправляю.',
    input: z.object({ conversationId: z.string() }),
    run: async (d, _t, i) => {
      if (!(await hasConversation(d.db, i.conversationId)))
        return done(false, TOOL_TEXTS.noConversation)
      const card = await openCard(d.db, i.conversationId)
      if (!card?.turn.text) return done(false, TOOL_TEXTS.noDraft)
      const view = await conversationView(d.db, i.conversationId)
      await d.notifier.sendButtons(TOOL_TEXTS.draftCard(view?.name ?? 'клиента', card.turn.text), [
        [{ text: CONV_TEXTS.buttons.send, callbackData: formatCallback(card.task.id, 'send') }],
      ])
      return done(true, TOOL_TEXTS.draftOffered)
    },
  }),
  answer_question: tool({
    description:
      'Сообщение Бориса в этом ходе это ответ на открытый вопрос (questionId из раздела «Открытый вопрос»). Программа возьмёт его слова дословно.',
    input: z.object({ questionId: z.string() }),
    run: async (d, t, i) => {
      const q = t.questions.find((x) => x.id === i.questionId)
      if (!q) return done(false, TOOL_TEXTS.notAsked)
      return done(true, await relay(d, await d.answerQuestion(q, t.said)))
    },
  }),
} as const

export type SecretaryToolName = keyof typeof SECRETARY_TOOLS

/**
 * A tool call of the model: the arguments get the turn's hidden values back, the answer is hidden again. A failure
 * is an answer too: the model hears it and tells Boris.
 */
export async function runTool(
  d: SecretaryDeps,
  t: TurnContext,
  name: string,
  args: unknown,
): Promise<{ text: string; isError: boolean }> {
  const def = (SECRETARY_TOOLS as Record<string, Tool<z.ZodObject>>)[name]
  if (!def) return { text: `Нет инструмента ${name}`, isError: true }
  const input = def.input.safeParse(restore(args ?? {}, t.redactor.tags))
  if (!input.success) return { text: input.error.message.slice(0, 500), isError: true }
  t.used.push(name)
  try {
    const out = await def.run(d, t, input.data)
    return { text: t.redactor.hide(JSON.stringify(out)), isError: false }
  } catch (e) {
    console.error('secretary tool failed', name, e instanceof Error ? e.message : e)
    return {
      text: 'Не получилось: сбой в ядре. Скажи Борису, что сделать это сейчас не вышло.',
      isError: true,
    }
  }
}
