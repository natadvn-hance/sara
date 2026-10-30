import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'
import type { Db } from '../db/client'
import type { Converse, ConverseResult } from '../gateway/gateway'
import { createRedactor } from '../gateway/redact'
import { appendEvent } from '../journal/journal'
import type { SecretaryWords } from '../learning/inbox'
import type { Notifier } from '../notify/notifier'
import { getSetting } from '../settings/store'
import { SECRETARY_MCP_SERVER, type TurnKeys } from './mcp'
import { addLine, type ChatLine, clientNamesToHide, memory, turnsToday } from './store'
import { SECRETARY_TOOLS, type TurnContext } from './tools'

/** A run that would cost more stops: a loop of tools never eats the subscription (ADR-027). */
const MAX_BUDGET_USD = 3
/** Telegram shows «печатает…» for about 5 seconds: it is sent again before it fades. */
const TYPING_EVERY_MS = 4500
/** Telegram's limit for one message is 4096 characters. */
const PART_MAX = 4000

export const SECRETARY_TEXTS = {
  limit: (until: string | null, pult: string) =>
    `Сейчас не могу ответить: кончился лимит Claude${until ? `, вернусь после ${until} по Москве` : ''}. Кнопки и пульт работают: ${pult}`,
  cap: (n: number) =>
    n === 0
      ? 'Разговор со мной сейчас выключен в настройках пульта. Кнопки и пульт работают.'
      : `На сегодня я исчерпала разговоры: ${n} из ${n}. Кнопки и пульт работают, а предел меняется в пульте, в настройках.`,
  timeout: 'Не успела ответить за 4 минуты. Спроси ещё раз, лучше покороче.',
  notConnected:
    'Не могу ответить: Claude не подключён. Кнопки работают, а подключение чинит разработчик.',
  failed: 'Не получилось ответить, сбой у Claude. Попробуй ещё раз через минуту, кнопки работают.',
} as const

const moscow = (d: Date, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', ...o }).format(d)
const clock = (d: Date) => moscow(d, { hour: '2-digit', minute: '2-digit' })
const stamp = (d: Date) =>
  moscow(d, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

const QUESTION_KINDS: Record<string, string> = {
  why_skip: 'почему он пропустил заявку',
  why_want: 'почему он взял бы заявку',
  why_decline: 'почему он отклонил предложение правил',
  edit_draft: 'новый текст отклика',
  edit_price: 'цена услуги в отклике',
}

/** One Boris message waiting for its turn, with the open questions it came after and its line in the chat. */
type Waiting = SecretaryWords & { lineId?: string }
/** A line of the memory longer than this is cut: twenty long answers must not fill a turn. */
const LINE_MAX = 1500
const cut = (t: string) => (t.length > LINE_MAX ? `${t.slice(0, LINE_MAX)}…` : t)

/** What the model reads in a turn (roles/secretary/role.md, «Что приходит на вход»). */
export function turnInput(o: {
  now: Date
  memory: ChatLine[]
  said: Waiting[]
  titles: Map<string, string | null>
}): string {
  const parts = [`## Сейчас\n${moscow(o.now, { dateStyle: 'long', timeStyle: 'short' })} по Москве`]
  parts.push(
    `## Наш разговор\n${
      o.memory.length === 0
        ? 'Пока пусто.'
        : o.memory
            .map(
              (l) =>
                `[${l.author === 'sara' ? 'Сара' : 'Борис'}, ${stamp(new Date(l.at))}] ${l.text}`,
            )
            .join('\n')
    }`,
  )
  const questions = [...new Map(o.said.flatMap((w) => w.questions).map((q) => [q.id, q])).values()]
  if (questions.length > 0)
    parts.push(
      `## Открытый вопрос\n${questions
        .map((q) => {
          const title = o.titles.get(q.id)
          const what = QUESTION_KINDS[q.kind] ?? 'мой вопрос'
          return `- questionId ${q.id}: ${what}${title ? ` («${title}»)` : ''}, спросила в ${clock(new Date(q.askedAt))}`
        })
        .join('\n')}`,
    )
  const replied = o.said.map((w) => w.replyToText).filter((t): t is string => !!t)
  if (replied.length > 0)
    parts.push(`## Он ответил на сообщение\n${replied.map((t) => `«${t}»`).join('\n')}`)
  parts.push(
    `## Новое сообщение Бориса\n${o.said
      .map((w) => (o.said.length > 1 ? `[${clock(w.at)}] ${w.text}` : w.text))
      .join('\n')}`,
  )
  return parts.join('\n\n')
}

/** The model's words as Telegram plain text: no Markdown marks, no long dash, parts that fit a message. */
export function answerParts(text: string): string[] {
  const clean = text
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[\u2013\u2014]/g, '-')
    .trim()
  const parts: string[] = []
  let rest = clean
  while (rest.length > PART_MAX) {
    const cut = rest.lastIndexOf('\n', PART_MAX)
    const at = cut > PART_MAX / 2 ? cut : PART_MAX
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

export type Secretary = {
  /** Boris's words for the next turn; the answer comes as its own message. */
  take(w: SecretaryWords): Promise<null>
  /** Resolves when no turn runs and none waits (tests, a clean stop). */
  idle(): Promise<void>
}

/**
 * The Secretary (ADR-027): one turn at a time; words that come during a turn wait and go together in the next one.
 * Each turn is one `claude -p` with Sara's tools, the chat's memory from the database and Boris's new words.
 */
export function createSecretary(d: {
  db: Db
  converse: Converse
  notifier: Pick<Notifier, 'sendText' | 'typing'>
  keys: TurnKeys
  /** The tools' address for the CLI, known once the core listens. */
  mcpUrl: () => string
  dataDir: string
  publicUrl: string
  /** Question titles for the input (the lead a «почему?» is about). */
  titleOf(q: SecretaryWords['questions'][number]): Promise<string | null>
  now?: () => Date
}): Secretary {
  const now = d.now ?? (() => new Date())
  const waiting: Waiting[] = []
  let running: Promise<void> | null = null

  async function say(text: string, saved: boolean): Promise<void> {
    for (const part of answerParts(text)) await d.notifier.sendText(part)
    if (saved) await addLine(d.db, { author: 'sara', text, at: now() })
  }

  async function journal(id: string, used: string[], r: ConverseResult | 'cap'): Promise<void> {
    await appendEvent(d.db, {
      type: 'secretary.answered',
      v: 1,
      entity: { kind: 'secretary_turn', id },
      account_id: null,
      actor: 'sara',
      occurred_at: now().toISOString(),
      causation_id: null,
      correlation_id: id,
      reason: r === 'cap' ? 'cap' : r.ok ? null : r.errorClass,
      payload: {
        tools: used,
        ...(r !== 'cap' && { modelCallId: r.modelCallId, durationMs: r.durationMs }),
      },
    })
  }

  async function turn(said: Waiting[]): Promise<void> {
    const id = newEventId()
    const cap = await getSetting(d.db, 'secretary.turns_per_day')
    if ((await turnsToday(d.db, now())) >= cap) {
      await say(SECRETARY_TEXTS.cap(cap), false)
      return journal(id, [], 'cap')
    }
    const titles = new Map<string, string | null>()
    for (const q of said.flatMap((w) => w.questions)) titles.set(q.id, await d.titleOf(q))
    const input = turnInput({
      now: now(),
      memory: await memory(
        d.db,
        now(),
        said.flatMap((w) => (w.lineId ? [w.lineId] : [])),
      ),
      said,
      titles,
    })
    const last = said.at(-1) as Waiting
    const t: TurnContext = {
      redactor: createRedactor(await clientNamesToHide(d.db, now())),
      said: { text: last.text, voice: last.voice, messageId: last.messageId, at: last.at },
      questions: said.flatMap((w) => w.questions),
      used: [],
    }
    const key = d.keys.open(t)
    const dir = join(d.dataDir, 'secretary')
    const configPath = join(dir, `mcp-${id}.json`)
    const typing = setInterval(() => void d.notifier.typing?.().catch(() => {}), TYPING_EVERY_MS)
    void d.notifier.typing?.().catch(() => {})
    let r: ConverseResult
    try {
      await mkdir(dir, { recursive: true })
      // The key is in a file only this user reads, not on the command line.
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            [SECRETARY_MCP_SERVER]: {
              type: 'http',
              url: d.mcpUrl(),
              headers: { Authorization: `Bearer ${key}` },
            },
          },
        }),
        { mode: 0o600 },
      )
      await chmod(configPath, 0o600)
      r = await d.converse('secretary', input, {
        redactor: t.redactor,
        mcp: {
          configPath,
          server: SECRETARY_MCP_SERVER,
          tools: Object.keys(SECRETARY_TOOLS),
        },
        correlationId: id,
        maxBudgetUsd: MAX_BUDGET_USD,
      })
    } finally {
      clearInterval(typing)
      d.keys.close(key)
      await rm(configPath, { force: true })
    }
    if (r.ok) await say(r.text, true)
    else if (r.errorClass === 'limit_reached')
      await say(SECRETARY_TEXTS.limit(r.resetAt ? clock(r.resetAt) : null, d.publicUrl), false)
    else if (r.errorClass === 'timeout') await say(SECRETARY_TEXTS.timeout, false)
    else if (r.errorClass === 'not_connected') await say(SECRETARY_TEXTS.notConnected, false)
    else await say(SECRETARY_TEXTS.failed, false)
    await journal(id, t.used, r)
  }

  async function drain(): Promise<void> {
    while (waiting.length > 0) {
      const said = waiting.splice(0)
      try {
        await turn(said)
      } catch (e) {
        console.error('secretary turn failed', e instanceof Error ? e.message : e)
        await d.notifier.sendText(SECRETARY_TEXTS.failed).catch(() => {})
      }
    }
    running = null
  }

  return {
    async take(w) {
      const lineId = await addLine(d.db, {
        author: 'boris',
        text: w.text,
        at: w.at,
        telegramMessageId: w.messageId ?? null,
      })
      waiting.push({ ...w, lineId })
      running ??= drain()
      return null
    },
    async idle() {
      while (running) await running
    },
  }
}
