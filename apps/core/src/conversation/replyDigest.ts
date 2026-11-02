import { createHash } from 'node:crypto'
import {
  CONV_STAGES,
  type ConvStage,
  formatCallback,
  newEventId,
  normalizeText,
  REPLY_SAMPLE_TASK,
  ReplyCleanerOutput,
  type TaskAction,
  TONES,
  TOPICS,
  type Tone,
  type Topic,
} from '@sara/shared'
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import {
  chatMessage,
  conversation,
  convTurn,
  jobRun,
  meeting,
  mindProposal,
  replyPick,
  task,
} from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { createRedactor, tagsIn } from '../gateway/redact'
import { frontmatter } from '../history/speechProposals'
import { appendEvent } from '../journal/journal'
import { namesToHide } from '../leads/clientName'
import { mskParts } from '../learning/summary'
import { proposeMind } from '../mind/proposals'
import type { Notifier } from '../notify/notifier'
import { getSetting } from '../settings/store'
import { notTest } from '../testLeads/sql'
import { similarity } from './compare'
import { clientNames } from './dossier'
import { dealOf } from './stage'
import { rowOf } from './store'

/**
 * The daily post of Boris's own replies (FR-SPEECH-5, docs/product/boris-replies-digest.md). Code picks the replies that
 * differ most from Sara's drafts, one cheap call takes out his typos, and each pair gets «В образцы» and «Не надо». The
 * press makes a proposal for the mind and nothing more: the confirmed mind changes only by `mind accept` (FR-MIND-3).
 */

export const REPLY_DIGEST_TEXTS = {
  head: '📚 Твои ответы, где ты написал не так, как предлагала я. Какие взять в образцы?',
  note: 'Имена, телефоны и ссылки скрыты, опечатки поправлены: так ответ и ляжет в образец. Осталось чужое название, жми «Не надо».',
  alike: (n: number) => `Совпало с моим на ${n}%`,
  client: 'Клиент',
  draft: 'Я предложила',
  reply: 'Ты ответил',
  promise: (words: string[]) => `⚠️ Обещание: ${words.join(', ')}. Сама такое не предложу.`,
  sampleButton: 'В образцы',
  dropButton: 'Не надо',
  markSampled: '✅ Взяла как предложение в образцы',
  markDropped: '✖️ Не берем',
  sampled: 'Записала предложением в разум. Сама в образцы не вливаю.',
  dropped: 'Не беру в образцы.',
  alreadyDone: 'Это уже решено.',
}

/** The post comes in the morning, for replies with at least the night behind them. */
const DIGEST_HOUR = 10
/** A reply this fresh waits: the client has had no time to answer, and the outcome would tell nothing. */
const MIN_AGE_MS = 12 * 3600_000
/** A reply older than this is left: the post is about the last days, not about the whole history. */
const MAX_AGE_MS = 7 * 24 * 3600_000
/** The turn comes before the reply, by a day at most in any chat worth showing. */
const TURN_LOOKBACK_MS = MAX_AGE_MS + 24 * 3600_000
const MAX_PAIRS = 5
/** As for the examples from history: a shorter message teaches nothing about his speech. */
const MIN_REPLY_CHARS = 15
/** A longer one is a document, not a sample of his speech. */
const MAX_REPLY_CHARS = 1500
/** The texts of the post share this much of a Telegram message; the head, labels and marks fit in the rest. */
const POST_TEXT_CHARS = 3200
const MAX_PROMISES_SHOWN = 3
/** Whose message is Boris's for certain and live: his text through Sara, or a specialist message after the switch. */
const LIVE_BASES = ['say', 'after_cutover']

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/** Words of a commercial promise, on folded text: what Boris may decide and Sara may not offer on her own. */
const PROMISE_PATTERNS = [
  /(?<!\p{L})(?:бесплатн\p{L}*|в подарок|даром|без оплаты|за (?:наш|свой) счет)(?!\p{L})/gu,
  /(?<!\p{L})(?:скидк\p{L}*|скидоч\p{L}*|уступ(?:им|лю)|сдела\p{L}* дешевле)(?!\p{L})/gu,
  /(?<!\p{L})(?:гарантир\p{L}*|гаранти[ияею]\p{L}*|вернем (?:деньги|оплату|предоплату)|возврат денег)(?!\p{L})/gu,
  // A sum: «20 000 рублей», «30 тысяч», «15к», «5000 ₽».
  /(?<![\p{L}\d])(?:\d[\d\s]*(?:₽|руб\p{L}*|тыс\p{L}*)|\d+к(?!\p{L}))/gu,
  // A term: «за 3 дня», «за пару недель», «за неделю».
  /(?<!\p{L})за\s+(?:(?:\d+|пару|два|две|три|четыре|пять|шесть|семь)\s+(?:час\p{L}*|дн\p{L}*|день|суток|недел\p{L}*|месяц\p{L}*)|неделю|месяц|сутки)(?!\p{L})/gu,
]

/** The commercial promises in a text, in the order they stand; each once. */
export function findPromises(text: string): string[] {
  const folded = fold(text)
  const found = PROMISE_PATTERNS.flatMap((re) =>
    [...folded.matchAll(re)].map((m) => ({ at: m.index, word: m[0].trim() })),
  ).sort((a, b) => a.at - b.at)
  return [...new Set(found.map((f) => f.word))]
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (row[j] as number) + 1,
        (next[j - 1] as number) + 1,
        (row[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    row = next
  }
  return row[b.length] as number
}

/** The model only fixed typos: the same tags, and few letters changed. Anything more is a rewrite of Boris's words. */
export function onlyTypos(before: string, after: string): boolean {
  if (tagsIn(before).join() !== tagsIn(after).join()) return false
  return editDistance(before, after) <= Math.max(3, Math.ceil(before.length * 0.08))
}

type Candidate = {
  turn: typeof convTurn.$inferSelect
  conv: typeof conversation.$inferSelect
  firstMessageId: string
  repliedAt: string
  client: string
  draft: string
  reply: string
  similarity: number
}

/** The new replies of Boris after Sara's drafts, the most different first; code only, nothing is sent anywhere. */
async function candidates(db: Db, now: Date): Promise<Candidate[]> {
  const from = now.getTime() - MAX_AGE_MS
  const to = now.getTime() - MIN_AGE_MS
  const turns = await db
    .select({ turn: convTurn, conv: conversation })
    .from(convTurn)
    .innerJoin(conversation, eq(convTurn.conversationId, conversation.id))
    .where(
      and(
        eq(convTurn.kind, 'reply'),
        isNotNull(convTurn.text),
        gte(convTurn.createdAt, new Date(now.getTime() - TURN_LOOKBACK_MS).toISOString()),
        // Test chats are no words of Boris to a client (docs/ops/test-leads.md).
        notTest(conversation.chatId),
        notTest(conversation.orderId),
        sql`not exists (select 1 from core.reply_pick p where p.turn_id = ${convTurn.id})`,
      ),
    )
    .orderBy(desc(convTurn.createdAt))
  if (turns.length === 0) return []
  const ids = [...new Set(turns.map((t) => t.conv.id))]
  const messages = await db
    .select()
    .from(chatMessage)
    .where(inArray(chatMessage.conversationId, ids))
    .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
  const shown = await db
    .select({ conv: replyPick.conversationId, first: replyPick.firstMessageId })
    .from(replyPick)
    .where(inArray(replyPick.conversationId, ids))
  const used = new Set(shown.map((s) => `${s.conv}:${s.first}`))
  const limit = await getSetting(db, 'auto.substantial_below')

  const out: Candidate[] = []
  for (const { turn, conv } of turns) {
    const chat = messages.filter((m) => m.conversationId === conv.id)
    const covered = (turn.messageIds as string[] | null) ?? []
    const at = chat.findIndex((m) => m.platformMessageId === covered.at(-1))
    if (at < 0) continue
    const next = chat.findIndex((m, i) => i > at && m.side === 'client')
    // Old Sara and a voice not known for certain stay out: a word of theirs is not his (ADR-024).
    const mine = chat
      .slice(at + 1, next < 0 ? undefined : next)
      .filter(
        (m) => m.author === 'boris' && m.source === 'node' && LIVE_BASES.includes(m.authorBasis),
      )
    const first = mine[0]
    const last = mine.at(-1)
    if (!first || !last) continue
    if (new Date(last.sentAt).getTime() > to || new Date(first.sentAt).getTime() < from) continue
    // The newest turn comes first, so of two over one client message the newer keeps the reply.
    const key = `${conv.id}:${first.platformMessageId}`
    if (used.has(key)) continue
    used.add(key)
    const client = covered
      .map((id) => chat.find((m) => m.platformMessageId === id)?.text.trim())
      .filter(Boolean)
      .join('\n\n')
    const reply = mine.map((m) => m.text.trim()).join('\n\n')
    if (!client || reply.length <= MIN_REPLY_CHARS || reply.length > MAX_REPLY_CHARS) continue
    const draft = turn.text as string
    const score = similarity(draft, reply)
    if (score >= limit) continue
    out.push({
      turn,
      conv,
      firstMessageId: first.platformMessageId,
      repliedAt: last.sentAt,
      client,
      draft,
      reply,
      similarity: score,
    })
  }
  return out.sort((a, b) => a.similarity - b.similarity)
}

type Hidden = Candidate & {
  names: string[]
  hidden: { client: string; draft: string; reply: string }
}

/** The first pairs whose client data can be hidden; a pair with no known name is left, as for history (NFR-PRIV-2). */
async function hideData(db: Db, list: Candidate[]): Promise<Hidden[]> {
  const out: Hidden[] = []
  for (const c of list) {
    if (out.length === MAX_PAIRS) break
    const names = namesToHide(...(await clientNames(db, rowOf(c.conv))))
    if (names.length === 0) continue
    const r = createRedactor(names)
    out.push({
      ...c,
      names,
      hidden: { client: r.hide(c.client), draft: r.hide(c.draft), reply: r.hide(c.reply) },
    })
  }
  return out
}

/** Boris's words without typos, or null when the call failed; a pair the model rewrote is not in the list. */
async function cleanReplies(
  gateway: Pick<Gateway, 'call'>,
  pairs: Hidden[],
): Promise<{ pair: Hidden; clean: string }[] | null> {
  const input = JSON.stringify({
    replies: pairs.map((p, i) => ({ n: i + 1, text: p.hidden.reply })),
  })
  const r = await gateway.call('reply-cleaner', input, ReplyCleanerOutput, {
    redact: { names: pairs.flatMap((p) => p.names), restore: false },
  })
  if (!r.ok) {
    console.error('reply digest: no cleaned replies', r.errorClass)
    return null
  }
  return pairs.flatMap((pair, i) => {
    const clean = r.output.replies
      .find((x) => x.n === i + 1)
      ?.text.trim()
      .replace(/[\u2014\u2013]/g, '-')
    return clean && onlyTypos(pair.hidden.reply, clean) ? [{ pair, clean }] : []
  })
}

type PickRow = typeof replyPick.$inferSelect

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The post as Boris sees it: each pair with its mark once decided. Numbers stay as they first were. */
function postText(rows: PickRow[]): string {
  const share = Math.floor(POST_TEXT_CHARS / Math.max(rows.length, 1))
  const T = REPLY_DIGEST_TEXTS
  const parts = rows.map((r) =>
    [
      `${r.position + 1}. ${T.alike(r.similarity)}`,
      `${T.client}: ${clip(oneLine(r.clientText), Math.floor(share * 0.2))}`,
      `${T.draft}: ${clip(oneLine(r.draftText), Math.floor(share * 0.2))}`,
      `${T.reply}: ${clip(r.replyText, Math.floor(share * 0.5))}`,
      ...(r.promises.length ? [T.promise(r.promises.slice(0, MAX_PROMISES_SHOWN))] : []),
      ...(r.decision === 'apply' ? [T.markSampled] : []),
      ...(r.decision === 'drop' ? [T.markDropped] : []),
    ].join('\n'),
  )
  return [`${T.head}\n${T.note}`, ...parts].join('\n\n')
}

const postRows = (rows: PickRow[]) =>
  rows
    .filter((r) => r.decision === null)
    .map((r) => [
      {
        text: `${r.position + 1}: ${REPLY_DIGEST_TEXTS.sampleButton}`,
        callbackData: formatCallback(r.id, 'apply'),
      },
      {
        text: `${r.position + 1}: ${REPLY_DIGEST_TEXTS.dropButton}`,
        callbackData: formatCallback(r.id, 'drop'),
      },
    ])

/**
 * One silent post a day (FR-SPEECH-5). A day with nothing new stays free and costs no call. The day's place is taken
 * before the model: one cheap call a day at most, so a limit or a refused post waits for tomorrow, not for the next tick.
 */
export async function replyDigest(
  d: { db: Db; notifier: Pick<Notifier, 'sendButtons'>; gateway: Pick<Gateway, 'call'> },
  now: Date = new Date(),
): Promise<'off' | 'not_yet' | 'already' | 'empty' | 'no_model' | 'sent'> {
  if (!(await getSetting(d.db, 'digest.boris_replies'))) return 'off'
  const { day, hour } = mskParts(now)
  if (hour < DIGEST_HOUR) return 'not_yet'
  const [done] = await d.db
    .select({ day: jobRun.day })
    .from(jobRun)
    .where(and(eq(jobRun.name, 'reply_digest'), eq(jobRun.day, day)))
  if (done) return 'already'
  const pairs = await hideData(d.db, await candidates(d.db, now))
  if (pairs.length === 0) return 'empty'
  const taken = await d.db
    .insert(jobRun)
    .values({ name: 'reply_digest', day })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  if (taken.length === 0) return 'already'

  const cleaned = await cleanReplies(d.gateway, pairs)
  if (cleaned === null) return 'no_model'
  if (cleaned.length === 0) return 'empty'

  const rows = cleaned.map(({ pair, clean }, position) => ({
    id: newEventId(),
    turnId: pair.turn.id,
    conversationId: pair.conv.id,
    firstMessageId: pair.firstMessageId,
    repliedAt: pair.repliedAt,
    similarity: pair.similarity,
    position,
    clientText: pair.hidden.client,
    draftText: pair.hidden.draft,
    replyText: clean,
    promises: findPromises(clean),
  }))
  const ids = rows.map((r) => r.id)
  const saved = await d.db.transaction(async (tx) => {
    await tx.insert(task).values(
      rows.map((r) => ({
        id: r.id,
        kind: REPLY_SAMPLE_TASK,
        entityKind: 'reply_pick',
        entityId: r.id,
      })),
    )
    return tx.insert(replyPick).values(rows).returning()
  })
  saved.sort((a, b) => a.position - b.position)
  let messageId: number
  try {
    ;({ messageId } = await d.notifier.sendButtons(postText(saved), postRows(saved), {
      quiet: true,
      place: 'general',
      notice: { kind: 'summary', title: 'Твои ответы: что взять в образцы' },
    }))
  } catch (e) {
    // Boris never saw them: the pairs are new again, for tomorrow's post.
    await d.db.transaction(async (tx) => {
      await tx.delete(replyPick).where(inArray(replyPick.id, ids))
      await tx.delete(task).where(inArray(task.id, ids))
    })
    throw e
  }
  await d.db.transaction(async (tx) => {
    await tx.update(replyPick).set({ postMessageId: messageId }).where(inArray(replyPick.id, ids))
    await tx.update(task).set({ telegramMessageId: messageId }).where(inArray(task.id, ids))
    await appendEvent(tx, {
      type: 'conv.replies_digest',
      v: 1,
      entity: { kind: 'job', id: 'reply_digest' },
      account_id: null,
      actor: 'sara',
      occurred_at: now.toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: { shown: rows.length },
    })
  })
  return 'sent'
}

const moscowDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d)
const moscowDayRu = (d: Date) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' }).format(d)

function waited(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} ч` : `${Math.round(hours / 24)} дн.`
}

/** What really came of the reply by now: whether the client answered it, and whether the chat reached a call. */
async function outcomeLine(db: DbOrTx, pick: PickRow, stage: string | null, now: Date) {
  const [answered] = await db
    .select({ at: sql<string | null>`min(${chatMessage.sentAt})` })
    .from(chatMessage)
    .where(
      and(
        eq(chatMessage.conversationId, pick.conversationId),
        eq(chatMessage.side, 'client'),
        sql`${chatMessage.sentAt} > ${pick.repliedAt}::timestamptz`,
      ),
    )
  const meetings = await db
    .select({ outcome: meeting.outcome })
    .from(meeting)
    .where(eq(meeting.conversationId, pick.conversationId))
  const held = stage === 'call_done' || meetings.some((m) => m.outcome === 'held')
  const booked = stage === 'call_booked' || meetings.some((m) => m.outcome !== 'missed')
  const client = answered?.at
    ? `клиент ответил через ${waited(new Date(answered.at).getTime() - new Date(pick.repliedAt).getTime())}`
    : 'клиент пока не ответил'
  const call = held ? 'созвон состоялся' : booked ? 'созвон назначен' : 'созвона нет'
  return `На ${moscowDayRu(now)}: ${client}, ${call}.`
}

const TOPIC_WORDS: Record<Topic, string> = {
  price: 'цена',
  contract: 'договор',
  discount: 'скидка',
  nda: 'NDA',
  call: 'созвон',
  process: 'как идет работа',
  timeline: 'сроки',
  cases: 'примеры работ',
  about: 'о Hance',
  smalltalk: 'разговор',
  other: 'другое',
}

/** The file of a proposal in the form of `e-boris-NN`: the fields, «Клиент» and «Борис», his promise and the outcome. */
async function sampleFile(tx: DbOrTx, pick: PickRow, now: Date) {
  const [row] = await tx
    .select({ turn: convTurn, conv: conversation })
    .from(convTurn)
    .innerJoin(conversation, eq(convTurn.conversationId, conversation.id))
    .where(eq(convTurn.id, pick.turnId))
  if (!row) return null
  const u = (row.turn.understanding ?? {}) as { topic?: unknown; tone?: unknown }
  const topic = (TOPICS as readonly unknown[]).includes(u.topic) ? (u.topic as Topic) : undefined
  const tone = (TONES as readonly unknown[]).includes(u.tone) ? (u.tone as Tone) : undefined
  const dealStage = (await dealOf(tx, row.conv))?.stage ?? null
  // The client wrote before this reply, so a chat with no deal behind it is talking.
  const stage: ConvStage = (CONV_STAGES as readonly (string | null)[]).includes(dealStage)
    ? (dealStage as ConvStage)
    : 'talking'
  const id = `e-l-${createHash('sha256').update(normalizeText(pick.replyText)).digest('hex').slice(0, 12)}`
  const today = moscowDay(now)
  const head = frontmatter({
    id,
    type: 'example',
    scope: 'shared',
    status: 'proposal',
    version: 1,
    title: topic ? `Живой ответ Бориса: ${TOPIC_WORDS[topic]}` : 'Живой ответ Бориса',
    ...(topic && { topic }),
    ...(tone && { tones: [tone] }),
    stages: [stage],
    sources: [`live:${row.conv.accountId}:${pick.firstMessageId}`, `boris-press:${today}`],
    valid_from: today,
    valid_to: null,
  })
  const promise = pick.promises.length
    ? `\n## Обещание\n\nОбещание Бориса: ${pick.promises.join(', ')}. Сара сама такое не предлагает.\n`
    : ''
  const outcome = await outcomeLine(tx, pick, dealStage, now)
  const body = `\n## Клиент\n\n${pick.clientText}\n\n## Борис\n\n${pick.replyText}\n${promise}\n## Исход\n\n${outcome}\n`
  return {
    accountId: row.conv.accountId,
    path: `mind/proposals/shared/speech/examples/${id}.md`,
    content: `${head}${body}`,
  }
}

/**
 * «В образцы» makes a proposal for the mind, «Не надо» only closes the pair; both once, and neither writes into the mind
 * (FR-MIND-3). A proposal `say` once made of the same turn's raw words gives way: his decision here is the one that
 * counts. The post is redrawn without that pair's buttons; a post Telegram will not edit does not undo the press.
 */
export async function onReplySamplePress(
  d: { db: Db; notifier: Pick<Notifier, 'editText'> },
  taskId: string,
  action: TaskAction,
  now: Date = new Date(),
): Promise<string> {
  const T = REPLY_DIGEST_TEXTS
  if (action !== 'apply' && action !== 'drop') return T.alreadyDone
  const at = now.toISOString()
  const pick = await d.db.transaction(async (tx) => {
    const resolved = await tx
      .update(task)
      .set({ state: 'resolved', resolution: action, resolvedAt: at })
      .where(and(eq(task.id, taskId), eq(task.kind, REPLY_SAMPLE_TASK), eq(task.state, 'open')))
      .returning({ id: task.id })
    if (resolved.length === 0) return null
    const [row] = await tx
      .update(replyPick)
      .set({ decision: action, decidedAt: at })
      .where(eq(replyPick.id, taskId))
      .returning()
    if (!row) return null
    await tx
      .update(mindProposal)
      .set({ state: 'rejected', decidedAt: at, rejectReason: 'решено в разборе ответов' })
      .where(and(eq(mindProposal.source, `boris:${row.turnId}`), eq(mindProposal.state, 'new')))
    const file = action === 'apply' ? await sampleFile(tx, row, now) : null
    if (file)
      await proposeMind(tx, {
        path: file.path,
        content: file.content,
        kind: 'example',
        source: `live:${row.turnId}`,
      })
    await appendEvent(tx, {
      type: action === 'apply' ? 'conv.reply_sampled' : 'conv.reply_dropped',
      v: 1,
      entity: { kind: 'conv_turn', id: row.turnId },
      account_id: file?.accountId ?? null,
      actor: 'boris',
      occurred_at: at,
      causation_id: null,
      correlation_id: row.conversationId,
      reason: null,
      payload: { similarity: row.similarity, promises: row.promises.length },
    })
    return row
  })
  if (!pick) return T.alreadyDone
  try {
    if (pick.postMessageId !== null) {
      const rows = await d.db
        .select()
        .from(replyPick)
        .where(eq(replyPick.postMessageId, pick.postMessageId))
        .orderBy(asc(replyPick.position))
      await d.notifier.editText?.(pick.postMessageId, postText(rows), postRows(rows))
    }
  } catch (e) {
    console.error(
      'reply digest: post not redrawn',
      e instanceof Error ? e.message.slice(0, 200) : e,
    )
  }
  return action === 'apply' ? T.sampled : T.dropped
}

/** Checks every `tickMs` whether the day's post is due. */
export function startReplyDigest(
  d: { db: Db; notifier: Pick<Notifier, 'sendButtons'>; gateway: Pick<Gateway, 'call'> },
  tickMs = 60_000,
  now?: () => Date,
): { stop(): void } {
  const timer = setInterval(() => {
    void replyDigest(d, now?.()).catch((e) =>
      console.error('reply digest failed', e instanceof Error ? e.message.slice(0, 200) : e),
    )
  }, tickMs)
  return { stop: () => clearInterval(timer) }
}
