import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { formatCallback, newEventId, type TaskAction } from '@sara/shared'
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { jobRun, mindProposal, task } from '../../db/schema'
import { TEXTS } from '../../notify/cards'
import { releaseNotice, takeNotice } from '../notices'
import { SCHOOL_TEXTS } from '../texts'
import type { SchoolDeps } from '../types'
import { createLesson, decideLesson } from './store'

type Deps = Pick<SchoolDeps, 'db' | 'notifier' | 'writer'>
type Bulk = 'examples' | 'scenarios'

const MSK_MS = 3 * 60 * 60_000
const SNOOZE_DAYS = 7
const mskDay = (t: number) => new Date(t + MSK_MS).toISOString().slice(0, 10)

/** M4's history proposals of one kind still waiting for Boris and not taken by a lesson. */
async function waiting(db: Db, bulk: Bulk) {
  return db
    .select()
    .from(mindProposal)
    .where(
      and(
        eq(mindProposal.kind, bulk === 'examples' ? 'example' : 'scenario'),
        like(mindProposal.source, 'history:%'),
        eq(mindProposal.state, 'new'),
        isNull(mindProposal.lessonId),
      ),
    )
}

const blankLesson = {
  scope: 'shared',
  topic: null,
  tone: null,
  questionType: null,
  clientText: null,
  before: null,
  inPlace: false,
  sim: false,
  modelCallId: null,
}

/**
 * What Boris reads of a mind file in a batch: its title and body without the front matter (M5 design 5.2: he sees
 * every fact); for a scenario, its title and the client's last words.
 */
export function readable(content: string): string {
  const t = content.trim()
  if (t.startsWith('{')) {
    try {
      const s = JSON.parse(t) as { title?: string; messages?: { author?: string; text?: string }[] }
      const client = s.messages?.filter((m) => m.author === 'client').at(-1)?.text
      return [s.title, client ? `Клиент: ${client}` : null].filter(Boolean).join('\n') || t
    } catch {
      return t
    }
  }
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t)
  if (!m) return t
  const title = /^title:\s*(.+)$/m
    .exec(m[1] ?? '')?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  return [title, t.slice(m[0].length).trim()].filter(Boolean).join('\n')
}

async function link(db: Db, proposalIds: string[], lessonId: string) {
  if (proposalIds.length === 0) return
  await db.update(mindProposal).set({ lessonId }).where(inArray(mindProposal.id, proposalIds))
}

/**
 * The starting mind (M5 design 5.2, source `import`): M4's proposals that are not history examples or scenarios,
 * and files under `mind/proposals/` of the clone that no row holds yet, become one lesson each, ready for a batch:
 * Boris sees every fact before it is written.
 */
export async function importMind(d: Pick<SchoolDeps, 'db' | 'mindDir'>): Promise<number> {
  const files = await proposalFiles(d.mindDir)
  const known = new Set(
    (await d.db.select({ path: mindProposal.path }).from(mindProposal)).map((r) => r.path),
  )
  for (const f of files) {
    if (known.has(f.path)) continue
    const type = /^type:\s*([a-z]+)/m.exec(f.front)?.[1]
    if (!type) continue
    await d.db
      .insert(mindProposal)
      .values({
        id: newEventId(),
        path: f.path,
        content: f.text,
        kind: type,
        source: `file:${f.path}`,
      })
      .onConflictDoNothing()
  }
  const rows = await d.db
    .select()
    .from(mindProposal)
    .where(
      and(
        eq(mindProposal.state, 'new'),
        isNull(mindProposal.lessonId),
        sql`not (${mindProposal.source} like 'history:%' and ${mindProposal.kind} in ('example', 'scenario'))`,
      ),
    )
  for (const p of rows) {
    const l = await createLesson(d.db, {
      ...blankLesson,
      source: 'import',
      sourceRef: p.id,
      after: readable(p.content).slice(0, 4000),
      insight: `Из стартового разума: ${p.source}`.slice(0, 240),
      kind: p.kind === 'knowledge' ? 'fact' : 'voice',
      state: 'ready',
      changes: [],
    })
    // Linked even when the lesson was there before: a crash between the two leaves no proposal behind.
    await link(d.db, [p.id], l.id)
  }
  return rows.length
}

async function proposalFiles(mindDir: string) {
  const root = join(mindDir, 'mind', 'proposals')
  const out: { path: string; text: string; front: string }[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.name.endsWith('.md')) {
        const text = await readFile(full, 'utf8')
        const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
        out.push({ path: relative(mindDir, full), text, front })
      }
    }
  }
  await walk(root)
  return out
}

async function snoozed(db: Db, bulk: Bulk, now: Date): Promise<boolean> {
  const since = mskDay(now.getTime() - SNOOZE_DAYS * 24 * 60 * 60_000)
  const rows = await db.execute(
    sql`select 1 from core.job_run where name = ${`history_snooze:${bulk}`} and day > ${since}`,
  )
  return rows.rows.length > 0
}

/**
 * One card for M4's history examples and one for its history scenarios (M5 design 5.2): «Да, все» writes them all
 * with one commit, «Посмотреть по 5» turns them into lessons for batches, «Не сейчас» asks again in a week.
 */
export async function historyCards(d: Deps, now: Date): Promise<void> {
  for (const bulk of ['examples', 'scenarios'] as const) {
    const rows = await waiting(d.db, bulk)
    if (rows.length === 0 || (await snoozed(d.db, bulk, now))) continue
    const [open] = await d.db
      .select({ id: task.id })
      .from(task)
      .where(and(eq(task.kind, 'history_bulk'), eq(task.entityId, bulk), eq(task.state, 'open')))
    if (open) continue
    const notice = await takeNotice(d.db, now, 'history_card')
    if (!notice) return
    const taskId = newEventId()
    await d.db
      .insert(task)
      .values({ id: taskId, kind: 'history_bulk', entityKind: 'history', entityId: bulk })
    const button = (text: string, action: TaskAction) => ({
      text,
      callbackData: formatCallback(taskId, action),
    })
    const { messageId } = await d.notifier
      .sendButtons(SCHOOL_TEXTS.historyCard(bulk, rows.length), [
        [button(SCHOOL_TEXTS.allYesButton, 'apply'), button(SCHOOL_TEXTS.byFiveButton, 'open')],
        [button(SCHOOL_TEXTS.notNowButton, 'skip')],
      ])
      .catch(async (e) => {
        await d.db.delete(task).where(eq(task.id, taskId))
        await releaseNotice(d.db, notice)
        throw e
      })
    await d.db.update(task).set({ telegramMessageId: messageId }).where(eq(task.id, taskId))
  }
}

/** Boris's press on a history card. */
export async function onHistoryPress(
  d: Deps,
  t: { id: string; entityId: string },
  action: TaskAction,
  now: Date,
): Promise<string> {
  const bulk = t.entityId as Bulk
  const resolved = await d.db
    .update(task)
    .set({ state: 'resolved', resolution: action, resolvedAt: now.toISOString() })
    .where(and(eq(task.id, t.id), eq(task.state, 'open')))
    .returning({ id: task.id })
  if (resolved.length === 0) return TEXTS.alreadyDone
  const rows = await waiting(d.db, bulk)
  if (action === 'skip') {
    await d.db
      .insert(jobRun)
      .values({ name: `history_snooze:${bulk}`, day: mskDay(now.getTime()) })
      .onConflictDoNothing()
    return SCHOOL_TEXTS.historyLater
  }
  if (action === 'open') {
    for (const p of rows) {
      const l = await createLesson(d.db, {
        ...blankLesson,
        source: 'history',
        sourceRef: p.id,
        after: readable(p.content).slice(0, 4000),
        insight: SCHOOL_TEXTS.historyInsight(bulk),
        kind: bulk === 'examples' ? 'voice' : 'procedure',
        state: 'ready',
        changes: [],
      })
      await link(d.db, [p.id], l.id)
    }
    return SCHOOL_TEXTS.historyByFive(rows.length)
  }
  if (action !== 'apply') return TEXTS.alreadyDone
  const l = await createLesson(d.db, {
    ...blankLesson,
    source: 'history',
    sourceRef: `bulk:${bulk}:${t.id}`,
    after: null,
    insight: SCHOOL_TEXTS.historyInsight(bulk),
    kind: 'bulk',
    state: 'asked',
    changes: [],
  })
  await link(
    d.db,
    rows.map((p) => p.id),
    l.id,
  )
  await decideLesson(d.db, l.id, { decision: 'yes' })
  // Written on the school's tick (writePending), which puts the result on this card.
  return SCHOOL_TEXTS.historyWriting(rows.length)
}
