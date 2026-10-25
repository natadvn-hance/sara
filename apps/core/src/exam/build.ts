import { createHash } from 'node:crypto'
import { type ChatAuthor, ExamScenario, LOCKED_TOPICS, type Topic } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import { NOT_NAMES } from '../conversation/check/phrases'
import type { Db } from '../db/client'
import { chatMessage, lead, mindProposal } from '../db/schema'
import { redact } from '../gateway/redact'
import { proposeMind } from '../mind/proposals'

/**
 * Exam scenarios from the history of the chats (FR-TRAIN-8, M4 design 5.13): each answer of Boris, with proof, to a
 * client's turn gives one scenario, depersonalized, kept as a row of `core.mind_proposal` (kind `scenario`, path
 * `exam/scenarios/x-h-<n>.json`). The core never writes into the mind folder: a developer exports the proposals and
 * Boris says «да» before a scenario joins the exam.
 */

type Category =
  | 'price'
  | 'discount'
  | 'contract'
  | 'nda'
  | 'call'
  | 'timeline'
  | 'cases'
  | 'process'
  | 'about'
  | 'other'

/** The kinds of question, in the order the picking takes them in turns; the first four are topics of Boris. */
const CATEGORIES: [Category, RegExp][] = [
  [
    'price',
    /цен[аыуе]|стоим|стоит|стоить|прайс|бюджет|оплат|тариф|сколько\s+(?:это\s+)?(?:будет\s+)?ст/iu,
  ],
  ['discount', /скидк|акци[яию]|дешевле|торг/iu],
  ['contract', /договор|гарант|\bакт[аы]?\b|документ/iu],
  ['nda', /\bnda\b|\bнда\b|конфиденц|неразглаш/iu],
  ['call', /созвон|позвон|звонок|звонить|набер|встреч/iu],
  ['timeline', /срок|сколько\s+времени|как\s+быстро|когда\s+будет|за\s+сколько\s+дн/iu],
  ['cases', /пример|кейс|портфолио|работали\s+с|делали\s+(?:уже|для)/iu],
  [
    'process',
    /как\s+будем|как\s+(?:вы\s+)?работа|с\s+чего\s+нач|что\s+нужно|этап|процесс|как\s+начн/iu,
  ],
  ['about', /кто\s+вы|кто\s+будет|чем\s+занима|опыт|команд|из\s+какого/iu],
  ['other', /./su],
]

const TITLE: Record<Category, string> = {
  price: 'вопрос о цене',
  discount: 'разговор о скидке',
  contract: 'вопрос о договоре',
  nda: 'вопрос о NDA',
  call: 'разговор о созвоне',
  timeline: 'вопрос о сроках',
  cases: 'просьба о примерах',
  process: 'вопрос о порядке работы',
  about: 'вопрос о Hance',
  other: 'вопрос клиента',
}

const LOCKED = new Set<Topic>(LOCKED_TOPICS)
const categoryOf = (text: string): Category =>
  CATEGORIES.find(([, re]) => re.test(text))?.[0] ?? 'other'

/** An answer shorter than this teaches nothing: «Да», «Хорошо». */
const MIN_REPLY = 15
/** How many messages before the client's turn a scenario keeps. */
const CONTEXT = 10

type Row = typeof chatMessage.$inferSelect

const iso = (t: string) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Phones, e-mails, links and the names given become tags with the same number everywhere in one scenario. */
function hide(text: string, names: string[]): string {
  return redact(text, names).text.replace(/\[(телефон|почта|ссылка|имя) \d+\]/gu, '[$1 1]')
}

type Candidate = {
  rows: Row[]
  /** Index of Boris's answer in `rows`. */
  answer: number
  /** Index of the first message of the client's turn. */
  turn: number
  category: Category
  ref: string
}

/** Every client turn that Boris answered himself, with proof, in the chats of the history. */
function candidatesOf(rows: Row[]): Candidate[] {
  const chats = new Map<string, Row[]>()
  for (const r of rows) {
    const key = `${r.accountId}/${r.chatId}`
    chats.set(key, [...(chats.get(key) ?? []), r])
  }
  const out: Candidate[] = []
  for (const chat of chats.values()) {
    chat.forEach((m, answer) => {
      if (m.author !== 'boris' || m.text.trim().length < MIN_REPLY) return
      let turn = answer
      while (turn > 0 && chat[turn - 1]?.side === 'client') turn--
      if (turn === answer) return
      const said = chat
        .slice(turn, answer)
        .map((x) => x.text)
        .join('\n')
      if (said.trim().length === 0) return
      const ref = createHash('sha256')
        .update(`${m.accountId}:${m.chatId}:${m.platformMessageId}`)
        .digest('hex')
        .slice(0, 12)
      out.push({ rows: chat, answer, turn, category: categoryOf(said), ref })
    })
  }
  return out
}

/** The newest first within a kind, the kinds taken in turns: the exam covers the kinds, not the newest week. */
function spread(candidates: Candidate[], limit: number): Candidate[] {
  const byKind = new Map<Category, Candidate[]>(CATEGORIES.map(([c]) => [c, []]))
  const when = (c: Candidate) => Date.parse(c.rows[c.answer]?.sentAt ?? '')
  for (const c of [...candidates].sort((a, b) => when(b) - when(a) || (a.ref < b.ref ? -1 : 1)))
    byKind.get(c.category)?.push(c)
  const picked: Candidate[] = []
  while (picked.length < limit && [...byKind.values()].some((l) => l.length > 0))
    for (const list of byKind.values()) {
      const next = list.shift()
      if (next && picked.length < limit) picked.push(next)
    }
  return picked
}

const NAME = '[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?'
/** «Ирина, добрый день», «Ирина! Добрый день»: a name before the comma at the start of a message of ours. */
const LEADING_NAME = new RegExp(`^\\s*(${NAME})\\s*[,!]`, 'u')
/** «Меня зовут Ирина Петрова», «это Ирина»: how a client names himself. */
const SELF_NAME = new RegExp(`(?:[Мм]еня\\s+зовут|[Ээ]то)\\s+(${NAME}(?:\\s+${NAME})?)`, 'gu')
/** A word that opens a message before a comma and is no client's name: the stoplist of the greeting check, and Boris. */
const NOT_A_NAME = new Set([
  ...NOT_NAMES,
  'борис',
  'расскажите',
  'напишите',
  'посмотрите',
  'пожалуйста',
  'если',
  'вот',
  'так',
  'ну',
])
const fold = (w: string) => w.toLowerCase().replace(/ё/g, 'е')

/**
 * The names to hide in a chat (ADR-016): the lead's, a name before the comma in any message of ours (a bid that said
 * only «Добрый день!» gives none, but Boris's answer may start «Ирина, ...»), and the name a client gave himself. A name
 * the builder cannot find leaks: with no name found at all, a scenario whose message opens with an unknown capitalized word and a comma is dropped.
 */
function namesOf(rows: Row[], leadName: string | undefined): string[] {
  const found = new Map<string, string>()
  const add = (name: string | undefined) => {
    if (name?.trim()) found.set(fold(name), name.trim())
  }
  add(leadName)
  for (const m of rows) {
    if (m.side === 'specialist') {
      const word = LEADING_NAME.exec(m.text)?.[1]
      if (word && !NOT_A_NAME.has(fold(word))) add(word)
    }
    if (m.side === 'client') for (const x of m.text.matchAll(SELF_NAME)) add(x[1])
  }
  return [...found.values()]
}

/** The first word that opens a text before a comma and is neither a known name nor a stopword; null if none. */
function unknownOpener(texts: string[], names: string[]): string | null {
  const known = new Set(names.flatMap((n) => n.split(/\s+/)).map(fold))
  for (const t of texts) {
    const word = /^\s*(\p{Lu}[\p{L}-]*)\s*,/u.exec(t)?.[1]
    if (word && !NOT_A_NAME.has(fold(word)) && !known.has(fold(word))) return word
  }
  return null
}

/** Whether a text still holds a name or a stem of it (a case ending may differ): the last look before a proposal. */
function holdsName(text: string, names: string[]): boolean {
  const lower = fold(text)
  return names
    .flatMap((n) => n.split(/\s+/))
    .filter((w) => [...w].length >= 3)
    .some((w) => {
      const word = fold(w)
      return lower.includes(word.length >= 5 ? word.slice(0, -2) : word)
    })
}

async function scenarioOf(db: Db, c: Candidate, n: number): Promise<ExamScenario | null> {
  const answer = c.rows[c.answer] as Row
  const [known] = answer.orderId
    ? await db.select().from(lead).where(eq(lead.id, answer.orderId))
    : []
  const names = namesOf(c.rows, known?.clientName)
  const tag = (t: string) => hide(t, names)
  const from = Math.max(0, c.turn - CONTEXT)
  const window = c.rows.slice(from, c.answer)
  // A window that does not start at the chat's start keeps the opening message: it is the bid.
  const opening = from > 0 && c.rows[0]?.side === 'specialist' ? [c.rows[0]] : []
  const messages = [...opening, ...window]
    .filter((m) => m.text.trim().length > 0)
    .map((m) => ({ author: m.author as ChatAuthor, text: tag(m.text), at: iso(m.sentAt) }))
  const topic = c.category as Topic
  const locked = LOCKED.has(topic) || c.category === 'call'
  const first = messages[0]
  const scenario = {
    id: `x-h-${n}`,
    title: `Из истории: ${TITLE[c.category]}`,
    source: { kind: 'history' as const, ref: c.ref },
    tags: {
      question_type: null,
      stage: 'talking' as const,
      tone: 'neutral' as const,
      archetype: null,
      hard: false,
      trap: false,
    },
    golden: false,
    order: {
      title: tag(known?.title ?? ''),
      category: known?.category ?? '',
      text: tag(known?.text ?? ''),
      budget_text: known?.budgetText ? tag(known.budgetText) : null,
      city: known?.city ?? '',
    },
    client_name: names.length > 0 ? '[имя 1]' : null,
    bid:
      first && first.author !== 'client' && c.rows[0]?.side === 'specialist'
        ? { text: first.text, author: first.author }
        : null,
    messages,
    state: { owner: 'sara' as const, owner_reason: null, boris_note: null },
    now: iso(answer.sentAt),
    expect: {
      move: locked ? ('call_boris' as const) : ('reply' as const),
      ...(locked ? { topic } : {}),
      must_not_contain: [],
      must_mention_any: [],
      boris_reply: tag(answer.text),
    },
    rubric: null,
  }
  const parsed = ExamScenario.safeParse(scenario)
  if (!parsed.success || parsed.data.messages.at(-1)?.author !== 'client') return null
  // The last look: no contact and no name may be left, or the scenario is not proposed at all.
  const text = JSON.stringify(parsed.data)
  const left = redact(text).counts
  if (left.phone + left.email + left.link > 0) return null
  if (holdsName(text, names)) return null
  // With no name found at all, a message that opens with a capitalized word and a comma may open with the client's
  // name that no rule can read («Anna, ...»): the scenario would leak it, so it is not proposed.
  if (
    names.length === 0 &&
    unknownOpener(
      [...opening, ...window, answer].map((m) => m.text),
      names,
    )
  )
    return null
  return parsed.data
}

/**
 * Proposes up to `limit` new scenarios from the history. A turn already proposed (by its source) is not proposed
 * again, and the numbers go on from the highest one proposed. Returns how many proposals were added.
 */
export async function buildScenarios(db: Db, o: { limit: number }): Promise<number> {
  const rows = await db
    .select()
    .from(chatMessage)
    .where(
      sql`(${chatMessage.accountId}, ${chatMessage.chatId}) in (select account_id, chat_id from core.chat_message where author = 'boris')`,
    )
    .orderBy(
      chatMessage.accountId,
      chatMessage.chatId,
      chatMessage.sentAt,
      chatMessage.platformMessageId,
    )
  const proposed = await db
    .select({ path: mindProposal.path, content: mindProposal.content })
    .from(mindProposal)
    .where(sql`${mindProposal.path} like 'exam/scenarios/x-h-%'`)
  const seen = new Set<string>()
  let last = 0
  for (const p of proposed) {
    last = Math.max(last, Number(/x-h-(\d+)\.json$/.exec(p.path)?.[1] ?? 0))
    try {
      const ref = (JSON.parse(p.content) as { source?: { ref?: string } }).source?.ref
      if (ref) seen.add(ref)
    } catch {
      // A proposal that is not JSON keeps its number and nothing else.
    }
  }
  const fresh = candidatesOf(rows).filter((c) => !seen.has(c.ref))
  let added = 0
  // Picked in turns over the kinds; a scenario that cannot be made clean is dropped and the next one is taken.
  const ordered = spread(fresh, fresh.length)
  for (const c of ordered) {
    if (added >= o.limit) break
    const n = last + 1
    const scenario = await scenarioOf(db, c, n)
    if (!scenario) continue
    const ok = await proposeMind(db, {
      path: `exam/scenarios/${scenario.id}.json`,
      content: `${JSON.stringify(scenario, null, 2)}\n`,
      kind: 'scenario',
      source: `history:${c.ref}`,
    })
    if (ok) {
      added++
      last = n
    }
  }
  return added
}
