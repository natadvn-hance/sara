import { createHash } from 'node:crypto'
import { formatCallback, newEventId, normalizeText, type TaskAction } from '@sara/shared'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { jobRun, lesson, mindGap, mindProposal, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { askOwnQuestion, type DraftAnswer } from '../learning/questions'
import { TEXTS } from '../notify/cards'
import { getSetting } from '../settings/store'
import { callMaker } from './lessons/maker'
import { knowledgeChange } from './lessons/records'
import { createLesson, decideLesson } from './lessons/store'
import { releaseNotice, takeNotice } from './notices'
import { SCHOOL_TEXTS } from './texts'
import type { LessonRow, MindChange, SchoolDeps } from './types'

const MSK_MS = 3 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
/** A gap from work counts this long; one that kept coming back is asked first (M5 design 5.9). */
const WORK_DAYS = 14
/** «Не знаю, пропустить» keeps a question away this long. */
const SKIP_DAYS = 7
/** Boris's answers older than this are not taken up by the tick any more. */
const ANSWER_DAYS = 2
/** An answer the model returned out of shape this many times is asked again in other words. */
const MAX_BAD = 3
/** The school writes from 10:00 to 22:59 Moscow time (notices.ts); the day's question is not looked for outside. */
const FROM_HOUR = 10
const TO_HOUR = 23
const SOURCE_RANK = { work: 0, teacher: 1, sim: 2 } as const

export type InterviewQuestion = {
  gapKey: string
  question: string
  source: keyof typeof SOURCE_RANK
  topic: string | null
  count: number
}

type GapRow = typeof mindGap.$inferSelect

const mskDay = (t: number) => new Date(t + MSK_MS).toISOString().slice(0, 10)
const keyOf = (text: string) =>
  createHash('sha1').update(normalizeText(text)).digest('hex').slice(0, 16)
const sourceOf = (turnId: string): InterviewQuestion['source'] =>
  turnId.startsWith('teacher:') ? 'teacher' : turnId.startsWith('sim:') ? 'sim' : 'work'
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const gapKeyOf = (l: Pick<LessonRow, 'sourceRef'>) => l.sourceRef.split(':')[0] ?? ''

/** Open gaps grouped by their words: the best source of the group, how many, the newest. */
function groups(rows: GapRow[]): (InterviewQuestion & { last: number })[] {
  const out = new Map<string, InterviewQuestion & { last: number }>()
  for (const g of rows) {
    const source = sourceOf(g.turnId)
    const key = keyOf(g.text)
    const at = Date.parse(g.createdAt)
    const old = out.get(key)
    if (old) {
      old.count++
      old.last = Math.max(old.last, at)
      if (SOURCE_RANK[source] < SOURCE_RANK[old.source]) old.source = source
      continue
    }
    out.set(key, {
      gapKey: key,
      question:
        source === 'teacher' ? g.text.trim() : SCHOOL_TEXTS.interviewQuestion(g.text.trim()),
      source,
      topic: g.topic,
      count: 1,
      last: at,
    })
  }
  return [...out.values()]
}

/**
 * The question words with work still in hand: a card waiting for Boris, a «да» not written yet, an answer the tick has
 * not taken yet. The day's question never asks them again (no second card for one question).
 */
async function pendingKeys(db: Db, now: Date): Promise<Set<string>> {
  const rows = await db.execute<{ key: string }>(sql`
    select split_part(source_ref, ':', 1) as key from core.lesson
    where source = 'interview' and (state = 'asked' or (state = 'yes' and commit_id is null))
    union
    select q.entity_id as key from core.question q
    where q.kind = 'interview' and q.answered_at > ${new Date(now.getTime() - ANSWER_DAYS * DAY_MS).toISOString()}
      and not exists (select 1 from core.lesson l
        where l.source = 'interview' and split_part(l.source_ref, ':', 2) = q.id::text)
      and not exists (select 1 from core.job_run j where j.name = 'interview_failed:' || q.id::text)`)
  return new Set(rows.rows.map((r) => r.key))
}

/**
 * What Sara would ask Boris (FR-MIND-4, M5 design 5.9): the open gaps grouped by their words, gaps from work first
 * (the most frequent of the last 14 days, then the newest), then the teacher's questions, then the generator's holes.
 * A question he skipped stays away for a week; one whose answer is in hand is not asked again.
 */
export async function interviewQueue(db: Db, now: Date, limit = 10): Promise<InterviewQuestion[]> {
  const rows = await db.select().from(mindGap).where(isNull(mindGap.lessonId))
  const skipped = new Set(
    (
      await db.execute<{ name: string }>(
        sql`select name from core.job_run where name like 'interview_skip:%'
          and day > ${mskDay(now.getTime() - SKIP_DAYS * DAY_MS)}`,
      )
    ).rows.map((r) => r.name.slice('interview_skip:'.length)),
  )
  const pending = await pendingKeys(db, now)
  const fresh = rows.filter(
    (g) =>
      sourceOf(g.turnId) !== 'work' ||
      now.getTime() - Date.parse(g.createdAt) <= WORK_DAYS * DAY_MS,
  )
  return groups(fresh)
    .filter((q) => !skipped.has(q.gapKey) && !pending.has(q.gapKey))
    .sort(
      (a, b) =>
        SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || b.count - a.count || b.last - a.last,
    )
    .slice(0, limit)
    .map(({ last: _last, ...q }) => q)
}

/** The question of these words while one of its gaps is still open, whatever its age or skip (an answer is welcome). */
async function openGap(db: Db, gapKey: string): Promise<InterviewQuestion | null> {
  const rows = await db.select().from(mindGap).where(isNull(mindGap.lessonId))
  const g = groups(rows.filter((r) => keyOf(r.text) === gapKey))[0]
  return g
    ? { gapKey, question: g.question, source: g.source, topic: g.topic, count: g.count }
    : null
}

/** The record Sara understood from Boris's answer, as his screens and the Telegram card show it. */
export type Understood = {
  lessonId: string
  title: string
  fact: string
  when: string
  notSay: string
}

export type AnswerResult =
  | { ok: true; understood: Understood }
  | {
      ok: false
      /** closed: no open gap; taken: another answer is being written; retry: the model did not answer this time;
       * bad: it answered out of shape; unclear: it found no fact in the answer. */
      why: 'closed' | 'taken' | 'retry' | 'bad' | 'unclear'
      reason: string
    }

/** Another answer to these words is decided «да» and not written yet: a second record of the same fact would come. */
async function taken(db: Db, gapKey: string, except: string | null): Promise<boolean> {
  const rows = await db
    .select({ id: lesson.id, ref: lesson.sourceRef })
    .from(lesson)
    .where(and(eq(lesson.source, 'interview'), eq(lesson.state, 'yes'), isNull(lesson.commitId)))
  return rows.some((r) => r.id !== except && gapKeyOf({ sourceRef: r.ref }) === gapKey)
}

/**
 * Boris's answer to an interview question becomes a knowledge record waiting for his «Правильно понимаю?» (FR-MIND-4):
 * one call of the lesson maker on sonnet, a lesson decided in place. A number in the record must be one he said
 * (the writer's guard checks it). `ref` names the answer (his message's question), so one answer makes one lesson.
 */
export async function answerInterview(
  d: Pick<SchoolDeps, 'db' | 'gateway'>,
  gapKey: string,
  answer: string,
  now: Date,
  ref: string = newEventId(),
): Promise<AnswerResult> {
  const q = await openGap(d.db, gapKey)
  if (!q) return { ok: false, why: 'closed', reason: SCHOOL_TEXTS.interviewClosed }
  if (await taken(d.db, gapKey, null))
    return { ok: false, why: 'taken', reason: SCHOOL_TEXTS.interviewTaken }
  const r = await callMaker(d.gateway, {
    mode: 'interview',
    clientText: null,
    before: null,
    after: answer,
    question: q.question,
    why: null,
    names: [],
    priority: 'P1',
  })
  if (!r.ok)
    return {
      ok: false,
      why: r.retry ? 'retry' : 'bad',
      reason: SCHOOL_TEXTS.interviewNotUnderstood,
    }
  const out = r.output
  if (!out.fact) return { ok: false, why: 'unclear', reason: SCHOOL_TEXTS.interviewNotUnderstood }
  const l = await createLesson(d.db, {
    source: 'interview',
    sourceRef: `${gapKey}:${ref}`,
    scope: 'shared',
    topic: out.topic,
    tone: out.tone,
    questionType: null,
    clientText: null,
    before: q.question,
    after: answer,
    insight: (out.insight || out.fact.title).slice(0, 240),
    kind: 'fact',
    state: 'asked',
    inPlace: true,
    sim: false,
    modelCallId: null,
    changes: [
      knowledgeChange({
        scope: 'shared',
        topic: out.topic,
        fact: out.fact,
        source: `interview:${gapKey}`,
        names: [],
      }),
    ],
  })
  await appendEvent(d.db, {
    type: 'interview.answered',
    v: 1,
    entity: { kind: 'lesson', id: l.id },
    account_id: null,
    actor: 'boris',
    occurred_at: now.toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { gap: gapKey, n: l.n },
  })
  return { ok: true, understood: await understoodOf(d.db, l.id) }
}

/** What the lesson's knowledge record says, as it will be written (its tags kept). */
async function understoodOf(db: Db, lessonId: string): Promise<Understood> {
  const [p] = await db
    .select({ change: mindProposal.change })
    .from(mindProposal)
    .where(eq(mindProposal.lessonId, lessonId))
  const c = p?.change as MindChange | undefined
  return {
    lessonId,
    title: c?.fields.title ?? '',
    fact: c?.sections['Факт'] ?? '',
    when: c?.sections['Когда говорить'] ?? '',
    notSay: c?.sections['Чего не говорить'] ?? '',
  }
}

/**
 * «Да, записать»: the record is decided; the school's tick writes it into the mind (`writePending`) and only then closes
 * the gaps of its words, so a record the guard refuses leaves the question open. A write never runs in a press.
 */
export async function confirmInterview(
  d: Pick<SchoolDeps, 'db'>,
  lessonId: string,
): Promise<string> {
  const [l] = await d.db.select().from(lesson).where(eq(lesson.id, lessonId))
  if (l && (await taken(d.db, gapKeyOf(l), l.id))) {
    await decideLesson(d.db, lessonId, { decision: 'skip', reason: 'уже есть ответ' })
    return SCHOOL_TEXTS.interviewTaken
  }
  const row = await decideLesson(d.db, lessonId, { decision: 'yes' })
  return row ? SCHOOL_TEXTS.interviewWriting : TEXTS.alreadyDone
}

/** The card «Я поняла так» of a lesson, or null when it never went out. */
async function cardOf(db: Db, lessonId: string): Promise<{ id: string; messageId: number } | null> {
  const [t] = await db
    .select({ id: task.id, messageId: task.telegramMessageId })
    .from(task)
    .where(and(eq(task.kind, 'interview_check'), eq(task.entityId, lessonId)))
  return t?.messageId ? { id: t.id, messageId: t.messageId } : null
}

/** The card keeps what Sara understood, gets a result line and loses its buttons. */
async function closeCard(d: Pick<SchoolDeps, 'db' | 'notifier'>, lessonId: string, line: string) {
  const card = await cardOf(d.db, lessonId)
  if (!card) return
  await d.notifier
    .editText(
      card.messageId,
      `${SCHOOL_TEXTS.interviewUnderstood(await understoodOf(d.db, lessonId))}\n\n${line}`,
      [],
    )
    .catch((e) => console.error('interview card not edited', errText(e)))
}

/**
 * The tick wrote an interview record (`refused` null) or the guard refused it: a written record closes every gap of
 * its words (FR-MIND-4), and the card says how it went.
 */
export async function reportInterview(
  d: Pick<SchoolDeps, 'db' | 'notifier'>,
  lessonId: string,
  refused: string | null,
): Promise<void> {
  if (!refused) {
    const [l] = await d.db.select().from(lesson).where(eq(lesson.id, lessonId))
    const key = l ? gapKeyOf(l) : ''
    const open = await d.db.select().from(mindGap).where(isNull(mindGap.lessonId))
    const ids = open.filter((g) => keyOf(g.text) === key).map((g) => g.id)
    if (ids.length > 0) await d.db.update(mindGap).set({ lessonId }).where(inArray(mindGap.id, ids))
  }
  await closeCard(
    d,
    lessonId,
    refused ? SCHOOL_TEXTS.interviewRefused(refused) : SCHOOL_TEXTS.interviewWritten,
  )
}

/** «Не знаю, пропустить»: the question waits a week; the record Sara understood is dropped. */
export async function skipInterview(db: Db, lessonId: string, now: Date): Promise<string> {
  const row = await decideLesson(db, lessonId, { decision: 'skip' })
  if (!row) return TEXTS.alreadyDone
  await db
    .insert(jobRun)
    .values({ name: `interview_skip:${gapKeyOf(row)}`, day: mskDay(now.getTime()) })
    .onConflictDoNothing()
  return SCHOOL_TEXTS.interviewSkipped
}

/**
 * The card «Я поняла так … Правильно понимаю?» with its task (kind interview_check). A card Telegram refused leaves the
 * lesson for the next tick to send again, with no second model call.
 */
async function sendUnderstood(d: Pick<SchoolDeps, 'db' | 'notifier'>, u: Understood) {
  const taskId = newEventId()
  await d.db
    .insert(task)
    .values({ id: taskId, kind: 'interview_check', entityKind: 'lesson', entityId: u.lessonId })
  const b = (text: string, action: TaskAction) => ({
    text,
    callbackData: formatCallback(taskId, action),
  })
  let messageId: number
  try {
    messageId = (
      await d.notifier.sendButtons(SCHOOL_TEXTS.interviewUnderstood(u), [
        [b(SCHOOL_TEXTS.writeButton, 'apply'), b(SCHOOL_TEXTS.fixButton, 'edit')],
        [b(SCHOOL_TEXTS.dontKnowButton, 'skip')],
      ])
    ).messageId
  } catch (e) {
    await d.db.delete(task).where(eq(task.id, taskId))
    throw e
  }
  await d.db.update(task).set({ telegramMessageId: messageId }).where(eq(task.id, taskId))
}

/**
 * Boris's words to the day's question or to «Что поправить?» (inbox hook). The message handler only thanks him: the
 * model call and the card come on the school's tick (`interviewAnswersStep`), so his next press is never kept waiting.
 */
export async function onSchoolAnswer(_d: unknown, _a: DraftAnswer): Promise<string> {
  return SCHOOL_TEXTS.interviewThinking
}

type AnswerRow = {
  id: string
  kind: string
  entity_id: string
  answer: string
  answered_at: string
}

const failed = (db: Db, qid: string, now: Date) =>
  db
    .insert(jobRun)
    .values({ name: `interview_failed:${qid}`, day: mskDay(now.getTime()) })
    .onConflictDoNothing()

/**
 * One answer taken up: a lesson made from it, or the reason it was not. The model not answering this time leaves it
 * for the next tick; an answer Sara could not understand is asked again, so his re-worded answer has a question.
 */
async function takeAnswer(
  d: Pick<SchoolDeps, 'db' | 'gateway' | 'notifier'>,
  q: AnswerRow,
  now: Date,
) {
  let gapKey = q.entity_id
  let text = q.answer
  let old: LessonRow | null = null
  if (q.kind === 'interview_fix') {
    const [row] = await d.db.select().from(lesson).where(eq(lesson.id, q.entity_id))
    if (!row) return failed(d.db, q.id, now)
    old = row as LessonRow
    gapKey = gapKeyOf(old)
    text = `${old.after ?? ''}\nПоправка: ${q.answer}`
  }
  const r = await answerInterview(d, gapKey, text, new Date(q.answered_at), q.id)
  if (r.ok || r.why === 'retry') return
  if (r.why === 'bad') {
    const [{ n } = { n: 0 }] = (
      await d.db.execute<{ n: number }>(
        sql`select count(*)::int as n from core.job_run where name like ${`interview_try:${q.id}:%`}`,
      )
    ).rows
    await d.db
      .insert(jobRun)
      .values({ name: `interview_try:${q.id}:${n + 1}`, day: mskDay(now.getTime()) })
      .onConflictDoNothing()
    if (n + 1 < MAX_BAD) return
  }
  await failed(d.db, q.id, now)
  if (r.why === 'closed' || r.why === 'taken') {
    await d.notifier.sendText(r.reason)
    return
  }
  if (old)
    await askOwnQuestion(
      d,
      { kind: 'interview_fix', entityId: old.id, text: SCHOOL_TEXTS.interviewFixAgain },
      now,
    )
  else {
    const g = await openGap(d.db, gapKey)
    await askOwnQuestion(
      d,
      {
        kind: 'interview',
        entityId: gapKey,
        text: SCHOOL_TEXTS.interviewAskAgain(g?.question ?? SCHOOL_TEXTS.interviewClosed),
      },
      now,
    )
  }
}

/**
 * The answers Boris gave since the last tick become cards «Я поняла так» (one lesson per answer: its source names the
 * question), then every such lesson without a card gets one. A correction drops the record understood before only
 * once its new card is out.
 */
export async function interviewAnswersStep(
  d: Pick<SchoolDeps, 'db' | 'gateway' | 'notifier'>,
  now: Date,
): Promise<void> {
  const since = new Date(now.getTime() - ANSWER_DAYS * DAY_MS).toISOString()
  const answers = await d.db.execute<AnswerRow>(sql`
    select q.id, q.kind, q.entity_id, q.answer, q.answered_at from core.question q
    where q.kind in ('interview', 'interview_fix') and q.answered_at is not null and q.answer is not null
      and q.answered_at > ${since}
      and not exists (select 1 from core.lesson l
        where l.source = 'interview' and split_part(l.source_ref, ':', 2) = q.id::text)
      and not exists (select 1 from core.job_run j where j.name = 'interview_failed:' || q.id::text)
    order by q.answered_at`)
  for (const q of answers.rows) {
    try {
      await takeAnswer(d, q, now)
    } catch (e) {
      console.error('interview answer not taken', errText(e))
    }
  }
  // Lessons from Telegram answers (their source names a question) whose card has not gone out.
  const cardless = await d.db.execute<{ id: string; kind: string; old: string }>(sql`
    select l.id, q.kind, q.entity_id as old from core.lesson l
    join core.question q on q.id::text = split_part(l.source_ref, ':', 2)
    where l.source = 'interview' and l.state = 'asked'
      and not exists (select 1 from core.task t
        where t.kind = 'interview_check' and t.entity_id = l.id::text and t.telegram_message_id is not null)
    order by l.n`)
  for (const l of cardless.rows) {
    try {
      await sendUnderstood(d, await understoodOf(d.db, l.id))
      if (l.kind === 'interview_fix')
        await decideLesson(d.db, l.old, { decision: 'skip', reason: 'поправил' })
    } catch (e) {
      console.error('interview card not sent', errText(e))
    }
  }
}

/** A press on the «Правильно понимаю?» card. */
export async function onInterviewPress(
  d: Pick<SchoolDeps, 'db' | 'notifier'>,
  t: { id: string; entityId: string },
  action: TaskAction,
  now: Date,
): Promise<string> {
  const rows = await d.db
    .update(task)
    .set({ state: 'resolved', resolution: action, resolvedAt: now.toISOString() })
    .where(and(eq(task.id, t.id), eq(task.state, 'open')))
    .returning({ id: task.id })
  if (rows.length === 0) return TEXTS.alreadyDone
  if (action === 'apply') return confirmInterview(d, t.entityId)
  if (action === 'skip') {
    const text = await skipInterview(d.db, t.entityId, now)
    await closeCard(d, t.entityId, text)
    return text
  }
  if (action === 'edit') {
    try {
      await askOwnQuestion(
        d,
        { kind: 'interview_fix', entityId: t.entityId, text: SCHOOL_TEXTS.interviewFixAsk },
        now,
      )
    } catch (e) {
      // Not asked: the card's buttons work again.
      console.error('interview fix not asked', errText(e))
      await d.db
        .update(task)
        .set({ state: 'open', resolution: null, resolvedAt: null })
        .where(eq(task.id, t.id))
      return SCHOOL_TEXTS.interviewFixFailed
    }
    await closeCard(d, t.entityId, SCHOOL_TEXTS.interviewFixAsked)
    return SCHOOL_TEXTS.interviewFixAsked
  }
  return TEXTS.alreadyDone
}

/** An answer or decision that came through the app: the Telegram card of that lesson is done too. */
export async function resolveCard(db: Db, lessonId: string, resolution: string, now: Date) {
  await db
    .update(task)
    .set({ state: 'resolved', resolution, resolvedAt: now.toISOString() })
    .where(
      and(eq(task.kind, 'interview_check'), eq(task.entityId, lessonId), eq(task.state, 'open')),
    )
}

/** Whether a lesson is an interview record (the app's routes decide only those). */
export async function isInterviewLesson(db: Db, lessonId: string): Promise<boolean> {
  const [l] = await db.select({ source: lesson.source }).from(lesson).where(eq(lesson.id, lessonId))
  return l?.source === 'interview'
}

/**
 * The day's interview question in Telegram (M5 design 5.9): one a day, the first of the queue, in the school's
 * hours and its daily count. The invitation into the app for three and more comes with the app's screens.
 */
export async function interviewStep(d: Pick<SchoolDeps, 'db' | 'notifier'>, now: Date) {
  const hour = new Date(now.getTime() + MSK_MS).getUTCHours()
  if (hour < FROM_HOUR || hour >= TO_HOUR) return
  if (!(await getSetting(d.db, 'school.on'))) return
  const day = mskDay(now.getTime())
  const [asked] = await d.db
    .execute(sql`select 1 from core.job_run where name = 'interview_asked' and day = ${day}`)
    .then((r) => r.rows)
  if (asked) return
  const [q] = await interviewQueue(d.db, now, 1)
  if (!q) return
  const notice = await takeNotice(d.db, now, 'interview')
  if (!notice) return
  // A question Telegram refused gives the day's place back and goes on the next tick.
  await askOwnQuestion(
    d,
    { kind: 'interview', entityId: q.gapKey, text: SCHOOL_TEXTS.interviewAsk(q.question) },
    now,
  ).catch(async (e) => {
    await releaseNotice(d.db, notice)
    throw e
  })
  await d.db.insert(jobRun).values({ name: 'interview_asked', day }).onConflictDoNothing()
}
