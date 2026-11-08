import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newEventId, parseCallback } from '@sara/shared'
import { and, asc, eq, ne } from 'drizzle-orm'
import { moscowDayStart } from '../conversation/cards'
import { type CommandDeps, openCardOf, proposeFreeSay, proposeSay } from '../conversation/commands'
import { getConversation } from '../conversation/store'
import type { MindSearch } from '../conversation/types'
import type { Db } from '../db/client'
import { chatMessage, lead } from '../db/schema'
import type { Converse, ConverseResult } from '../gateway/gateway'
import { createRedactor } from '../gateway/redact'
import { appendEvent } from '../journal/journal'
import { esc } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import type { TurnKeys } from '../secretary/mcp'
import { answerParts, SECRETARY_TEXTS } from '../secretary/secretary'
import { turnsToday } from '../secretary/store'
import { getSetting } from '../settings/store'
import { chatTurnsToday, closeVersions, noteDiscussion, openDiscussion } from './discussion'
import { TOPIC_TOOLS, type TopicTurn } from './tools'

/** Where the CLI of a topic turn finds its tools: the core itself, from the same machine only. */
export const TOPIC_MCP_PATH = '/internal/topic-chat/mcp'
export const TOPIC_MCP_SERVER = 'sara'
const MAX_BUDGET_USD = 3
const TYPING_EVERY_MS = 4500
/** The chat's lines that go into a turn without a tool call. */
const CHAT_LINES = 30
const LINE_MAX = 1200
const cut = (t: string, n = LINE_MAX) => (t.length > n ? `${t.slice(0, n)}…` : t)

export const TOPIC_TEXTS = {
  superseded: 'Есть вариант новее',
  noDraftAllowed: 'Не могу показать вариант: разговор закрыт.',
} as const

const moscow = (d: Date, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', ...o }).format(d)
const stamp = (d: Date) =>
  moscow(d, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const clock = (d: Date) => moscow(d, { hour: '2-digit', minute: '2-digit' })

/** Boris's words waiting for their turn in one topic. */
export type TopicWords = {
  conversationId: string
  text: string
  voice: boolean
  /** His post in the topic (negative reference), so it leaves with the discussion. */
  messageRef?: number
  at: Date
}

/** His voice, heard: a quiet folded quote under it, opened by a tap. */
export const transcriptPost = (text: string) => `<blockquote expandable>🎙 ${esc(text)}</blockquote>`

const WHO: Record<string, string> = {
  boris: 'Борис',
  transcript: 'Борис (голосом)',
  sara: 'Сара',
  version: 'Сара, вариант для клиента',
}

/** What the model reads in a turn (roles/topic-chat/role.md, «Что приходит на вход»). */
export function topicInput(o: {
  now: Date
  order: { title: string; text: string; clientName: string } | null
  chat: { side: string; text: string; at: string }[]
  draft: string | null
  borisNote: string | null
  discussion: { kind: string; text: string | null; at: string }[]
  said: TopicWords[]
}): string {
  const parts = [`## Сейчас\n${moscow(o.now, { dateStyle: 'long', timeStyle: 'short' })} по Москве`]
  parts.push(
    `## Заявка\n${
      o.order
        ? `${o.order.title}\nИмя на заказе: ${o.order.clientName}\n${cut(o.order.text, 1500)}`
        : 'Нет заявки (клиент написал сам).'
    }`,
  )
  parts.push(
    `## Чат с клиентом (последние ${CHAT_LINES})\n${
      o.chat.length === 0
        ? 'Пока пусто.'
        : o.chat
            .map(
              (m) =>
                `[${m.side === 'client' ? 'Клиент' : 'Мы'}, ${stamp(new Date(m.at))}] ${cut(m.text)}`,
            )
            .join('\n')
    }`,
  )
  parts.push(`## Черновик Сары, который ждёт решения\n${o.draft ?? 'Нет.'}`)
  parts.push(`## Указания Бориса по этому клиенту\n${o.borisNote ?? 'Нет.'}`)
  const said = o.discussion.filter((r) => r.text)
  parts.push(
    `## Наш разговор в теме об этом ответе\n${
      said.length === 0
        ? 'Пока пусто.'
        : said
            .map((r) => `[${WHO[r.kind] ?? r.kind}, ${clock(new Date(r.at))}] ${cut(r.text ?? '')}`)
            .join('\n')
    }`,
  )
  parts.push(
    `## Новое от Бориса\n${o.said
      .map(
        (w) =>
          `${o.said.length > 1 ? `[${clock(w.at)}] ` : ''}${w.voice ? '(голосом) ' : ''}${w.text}`,
      )
      .join('\n')}`,
  )
  return parts.join('\n\n')
}

export type TopicChat = {
  take(w: TopicWords): Promise<void>
  /** The tool `propose` of a turn: the version's card in the topic. */
  propose(t: TopicTurn, text: string): Promise<{ ok: boolean; message: string }>
  /** Resolves when no turn runs and none waits (tests, a clean stop). */
  idle(): Promise<void>
}

export type TopicChatDeps = {
  db: Db
  converse: Converse
  notifier: Pick<Notifier, 'sendText' | 'sendButtons' | 'markDone' | 'typing'>
  commands: () => CommandDeps
  mind: MindSearch
  keys: TurnKeys<TopicTurn>
  mcpUrl: () => string
  dataDir: string
  publicUrl: string
  now?: () => Date
}

/**
 * The chat in a client's topic (docs/superpowers/specs/2026-11-07-topic-chat-design.md): Boris's words about the
 * answer go to Sara, who rewrites the draft by them and shows the version with «Отправить». One turn at a time; words
 * that come during a turn go together in the next one of their topic.
 */
export function createTopicChat(d: TopicChatDeps): TopicChat {
  const now = d.now ?? (() => new Date())
  const waiting: TopicWords[] = []
  let running: Promise<void> | null = null

  /** A post of Sara's in the topic, kept as part of the discussion. */
  async function post(conversationId: string, text: string, kind: 'sara' | 'transcript') {
    const html = kind === 'transcript'
    const parts = html ? [text] : answerParts(text)
    for (const part of parts) {
      const r = await d.notifier.sendText(html ? transcriptPost(part) : part, {
        place: { conversation: conversationId },
        ...(html && { html: true, quiet: true }),
      })
      await noteDiscussion(d.db, {
        conversationId,
        ref: r.messageId,
        kind,
        text: part,
        at: now(),
      })
    }
  }

  /** The version for the client: the open draft's card stays, the version is a card of its own with «Отправить». */
  async function propose(t: TopicTurn, text: string): Promise<{ ok: boolean; message: string }> {
    const conv = await getConversation(d.db, t.conversationId)
    if (!conv || conv.closedAt) return { ok: false, message: TOPIC_TEXTS.noDraftAllowed }
    const cmd = d.commands()
    await closeVersions({ db: d.db, notifier: d.notifier }, conv.id, TOPIC_TEXTS.superseded)
    const open = await openCardOf(d.db, conv.id)
    const reply =
      open && open.turn.kind !== 'say'
        ? await proposeSay(cmd, open.turn, text, { via: 'edit', chat: true })
        : await proposeFreeSay(cmd, conv.id, text, { chat: true })
    if (typeof reply === 'string') return { ok: false, message: reply }
    const taskId = parseCallback(reply.rows[0]?.[0]?.callbackData ?? '')?.taskId
    const r = await d.notifier.sendButtons(reply.text, reply.rows, {
      place: { conversation: conv.id },
    })
    await noteDiscussion(d.db, {
      conversationId: conv.id,
      ref: r.messageId,
      kind: 'version',
      text,
      taskId: taskId ?? null,
      at: now(),
    })
    t.proposed++
    return { ok: true, message: 'Показала Борису вариант с кнопкой «Отправить».' }
  }

  async function journal(
    id: string,
    conversationId: string,
    t: TopicTurn | null,
    r: ConverseResult | 'cap',
  ) {
    await appendEvent(d.db, {
      type: 'topic.chat_answered',
      v: 1,
      entity: { kind: 'conversation', id: conversationId },
      account_id: t?.accountId ?? null,
      actor: 'sara',
      occurred_at: now().toISOString(),
      causation_id: null,
      correlation_id: id,
      reason: r === 'cap' ? 'cap' : r.ok ? null : r.errorClass,
      payload: {
        tools: t?.used ?? [],
        versions: t?.proposed ?? 0,
        ...(r !== 'cap' && { modelCallId: r.modelCallId, durationMs: r.durationMs }),
      },
    })
  }

  async function turn(conversationId: string, said: TopicWords[]): Promise<void> {
    const id = newEventId()
    const conv = await getConversation(d.db, conversationId)
    if (!conv) return
    // His words and his voice are part of the discussion whatever the turn does.
    for (const w of said) {
      if (w.messageRef !== undefined && w.messageRef < 0)
        await noteDiscussion(d.db, {
          conversationId,
          ref: w.messageRef,
          kind: 'boris',
          text: w.voice ? null : w.text,
          at: w.at,
        })
      if (w.voice) await post(conversationId, w.text, 'transcript')
    }
    const cap = await getSetting(d.db, 'secretary.turns_per_day')
    const today =
      (await turnsToday(d.db, now())) + (await chatTurnsToday(d.db, moscowDayStart(now())))
    if (today >= cap) {
      await post(conversationId, SECRETARY_TEXTS.cap(cap), 'sara')
      return journal(id, conversationId, null, 'cap')
    }
    const [l] = conv.orderId ? await d.db.select().from(lead).where(eq(lead.id, conv.orderId)) : []
    const chat = await d.db
      .select({ side: chatMessage.side, text: chatMessage.text, at: chatMessage.sentAt })
      .from(chatMessage)
      .where(and(eq(chatMessage.conversationId, conv.id), ne(chatMessage.side, 'system')))
      .orderBy(asc(chatMessage.sentAt))
    const open = await openCardOf(d.db, conv.id)
    const discussion = await openDiscussion(d.db, conv.id)
    const input = topicInput({
      now: now(),
      order: l ? { title: l.title, text: l.text, clientName: l.clientName } : null,
      chat: chat.slice(-CHAT_LINES),
      draft: open?.turn.text ?? null,
      borisNote: conv.borisNote,
      // The words of this turn are «Новое от Бориса», not the talk before it.
      discussion: discussion
        .filter((r) => !said.some((w) => w.messageRef === r.ref) && r.kind !== 'transcript')
        .map((r) => ({ kind: r.kind, text: r.text, at: r.createdAt })),
      said,
    })
    const t: TopicTurn = {
      conversationId: conv.id,
      accountId: conv.accountId,
      orderId: conv.orderId,
      redactor: createRedactor(l?.clientName ? [l.clientName] : []),
      used: [],
      proposed: 0,
    }
    const key = d.keys.open(t)
    const dir = join(d.dataDir, 'topic-chat')
    const configPath = join(dir, `mcp-${id}.json`)
    const typing = setInterval(() => void d.notifier.typing?.().catch(() => {}), TYPING_EVERY_MS)
    void d.notifier.typing?.().catch(() => {})
    let r: ConverseResult
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            [TOPIC_MCP_SERVER]: {
              type: 'http',
              url: d.mcpUrl(),
              headers: { Authorization: `Bearer ${key}` },
            },
          },
        }),
        { mode: 0o600 },
      )
      await chmod(configPath, 0o600)
      r = await d.converse('topic-chat', input, {
        redactor: t.redactor,
        mcp: { configPath, server: TOPIC_MCP_SERVER, tools: Object.keys(TOPIC_TOOLS) },
        correlationId: id,
        maxBudgetUsd: MAX_BUDGET_USD,
      })
    } finally {
      clearInterval(typing)
      d.keys.close(key)
      await rm(configPath, { force: true })
    }
    if (r.ok) {
      // After a version a bare «Готово» says nothing the card does not: the topic stays clean.
      const words = r.text.trim()
      if (words && !(t.proposed > 0 && /^готово[.!]?$/i.test(words)))
        await post(conv.id, r.text, 'sara')
    } else if (r.errorClass === 'limit_reached')
      await post(
        conv.id,
        SECRETARY_TEXTS.limit(r.resetAt ? clock(r.resetAt) : null, d.publicUrl),
        'sara',
      )
    else if (r.errorClass === 'timeout') await post(conv.id, SECRETARY_TEXTS.timeout, 'sara')
    else if (r.errorClass === 'not_connected')
      await post(conv.id, SECRETARY_TEXTS.notConnected, 'sara')
    else await post(conv.id, SECRETARY_TEXTS.failed, 'sara')
    await journal(id, conv.id, t, r)
  }

  async function drain(): Promise<void> {
    while (waiting.length > 0) {
      const first = waiting[0] as TopicWords
      const said = waiting.filter((w) => w.conversationId === first.conversationId)
      for (const w of said) waiting.splice(waiting.indexOf(w), 1)
      try {
        await turn(first.conversationId, said)
      } catch (e) {
        console.error('topic chat turn failed', e instanceof Error ? e.message : e)
        await d.notifier
          .sendText(SECRETARY_TEXTS.failed, { place: { conversation: first.conversationId } })
          .catch(() => {})
      }
    }
    running = null
  }

  return {
    propose,
    async take(w) {
      waiting.push(w)
      running ??= drain()
    },
    async idle() {
      while (running) await running
    },
  }
}
