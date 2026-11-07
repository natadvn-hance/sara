import { MIND_TYPES } from '@sara/shared'
import { and, asc, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { standingMeeting } from '../conversation/meetings'
import { getConversation, updateConversation } from '../conversation/store'
import type { MindSearch } from '../conversation/types'
import type { Db } from '../db/client'
import { chatMessage } from '../db/schema'
import { type Redactor, restore } from '../gateway/redact'
import { clientView } from '../pult/clients'
import { leadView } from '../pult/leads'

/** One turn of the chat in a client's topic, as its tools see it. */
export type TopicTurn = {
  conversationId: string
  accountId: string
  orderId: string | null
  /** The turn's hiding (ADR-016): answers go out through it, arguments come back through it. */
  redactor: Redactor
  /** The tools this turn called, for the journal. */
  used: string[]
  /** The versions this turn showed (each one replaces the one before it). */
  proposed: number
}

export type TopicToolDeps = {
  db: Db
  mind: MindSearch
  /** Shows a version for the client with «Отправить» and «Изменить»; nothing goes to the client. */
  propose(t: TopicTurn, text: string): Promise<{ ok: boolean; message: string }>
  now?: () => Date
}

type Tool<I extends z.ZodObject> = {
  description: string
  input: I
  run(d: TopicToolDeps, t: TopicTurn, input: z.infer<I>): Promise<unknown>
}
const tool = <I extends z.ZodObject>(t: Tool<I>) => t

const moscowDate = (d: Date) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
  }).format(d)

/** The tools of the topic chat. None of them sends anything to the client: a version waits for «Отправить». */
export const TOPIC_TOOLS = {
  chat: tool({
    description:
      'Весь чат с этим клиентом на Профи.ру, по порядку: кто писал (Клиент или Мы), когда и что. limit: сколько последних сообщений (по умолчанию 60).',
    input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    async run(d, t, i) {
      const rows = await d.db
        .select({ side: chatMessage.side, text: chatMessage.text, at: chatMessage.sentAt })
        .from(chatMessage)
        .where(
          and(eq(chatMessage.conversationId, t.conversationId), ne(chatMessage.side, 'system')),
        )
        .orderBy(asc(chatMessage.sentAt))
      return rows.slice(-(i.limit ?? 60)).map((r) => ({
        who: r.side === 'client' ? 'Клиент' : 'Мы',
        at: r.at,
        text: r.text,
      }))
    },
  }),
  order: tool({
    description: 'Заявка этого клиента целиком: название, текст, город, бюджет, отклик.',
    input: z.object({}),
    async run(d, t) {
      return t.orderId ? ((await leadView(d.db, t.orderId)) ?? 'Заявки нет') : 'Заявки нет'
    },
  }),
  client: tool({
    description:
      'Карточка клиента из пульта: стадия, указания Бориса, заметки, встречи, итог сделки.',
    input: z.object({}),
    async run(d, t) {
      return (await clientView(d.db, t.conversationId)) ?? 'Карточки нет'
    },
  }),
  meeting: tool({
    description:
      'Ближайший созвон с этим клиентом (в пределах суток вокруг сейчас): когда, как, итог.',
    input: z.object({}),
    async run(d, t) {
      const m = await standingMeeting(d.db, t.conversationId, d.now?.() ?? new Date())
      if (!m) return 'Созвона нет'
      return {
        startsAt: m.startsAt,
        how: m.how,
        caller: m.caller,
        status: m.status,
        outcome: m.outcome,
        result: m.result,
        nextStep: m.nextStep,
      }
    },
  }),
  mind: tool({
    description:
      'Разум Hance: знания, понимание, речь Бориса, суждения и примеры по словам запроса. До 5 записей.',
    input: z.object({ text: z.string().min(3).max(300) }),
    async run(d, t, i) {
      const hits = await d.mind.search({
        text: i.text,
        scope: t.accountId,
        types: [...MIND_TYPES],
        limit: 5,
      })
      return hits.map((h) => ({ title: h.title, type: h.type, body: h.body.slice(0, 1500) }))
    },
  }),
  propose: tool({
    description:
      'Показать Борису новый вариант ответа клиенту с кнопками «Отправить» и «Изменить». Клиенту ничего не уходит, пока Борис не нажмёт «Отправить». Прошлый вариант из этого обсуждения теряет кнопки. text: ровно то, что уйдёт клиенту.',
    input: z.object({ text: z.string().min(1).max(3500) }),
    async run(d, t, i) {
      return d.propose(t, i.text.trim())
    },
  }),
  remember: tool({
    description:
      'Запомнить указание Бориса по этому клиенту надолго (например «цену в чате не называем», «она хочет созвон по вторникам»). Его увидят все следующие ответы этому клиенту. Только его указания, своими словами коротко.',
    input: z.object({ instruction: z.string().min(3).max(500) }),
    async run(d, t, i) {
      const conv = await getConversation(d.db, t.conversationId)
      if (!conv) return { ok: false, message: 'Разговора нет' }
      const line = `${moscowDate(d.now?.() ?? new Date())}: ${i.instruction.trim()}`
      await updateConversation(d.db, conv.id, {
        borisNote: [conv.borisNote, line].filter(Boolean).join('\n'),
      })
      return { ok: true, message: 'Запомнила' }
    },
  }),
}

export async function runTopicTool(
  d: TopicToolDeps,
  t: TopicTurn,
  name: string,
  args: unknown,
): Promise<{ text: string; isError: boolean }> {
  const def = (TOPIC_TOOLS as Record<string, Tool<z.ZodObject>>)[name]
  if (!def) return { text: `Нет инструмента ${name}`, isError: true }
  const input = def.input.safeParse(restore(args ?? {}, t.redactor.tags))
  if (!input.success) return { text: input.error.message.slice(0, 500), isError: true }
  t.used.push(name)
  try {
    const out = await def.run(d, t, input.data)
    return { text: t.redactor.hide(JSON.stringify(out)), isError: false }
  } catch (e) {
    console.error('topic chat tool failed', name, e instanceof Error ? e.message : e)
    return { text: 'Не получилось: сбой в ядре.', isError: true }
  }
}
