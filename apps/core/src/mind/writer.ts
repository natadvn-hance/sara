import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { ExamScenario, MindFrontmatter, newEventId } from '@sara/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type pg from 'pg'
import type { Db, DbOrTx } from '../db/client'
import { conversation, convTurn, lead, lesson, mindCommit, mindProposal } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { namesToHide } from '../leads/clientName'
import type { LessonRow, MindChange, MindWriter, Refused, WriteResult } from '../school/types'
import type { SecretStore } from '../secrets/store'
import { type GitRunner, gitBinary, SARA_AUTHOR, SARA_EMAIL } from './git'
import { guardRecord } from './guard'
import { confirmContent, renderRecord, splitRecord } from './render'

const MSK_MS = 3 * 60 * 60_000
/** How long a writer waits for another one to finish (M5 design 5.3). */
const LOCK_WAIT_MS = 30_000
/** How many recent commits are read back to repair a crash between a commit and the database. */
const RECONCILE_DEPTH = 50
/** How many commits are read to know which of Sara's commits GitHub has or the clone already holds. */
const HISTORY_DEPTH = 2000
/** A git index lock older than this was left by a git that died: no git runs that long under the mind's lock. */
const STALE_LOCK_MS = 10 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Every ssh to GitHub gives up instead of hanging (the key is added when there is one). */
const SSH =
  'ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4'

type Existing = { path: string; version: number; status: string; scope: string; text: string }

/**
 * Runs `fn` while holding the mind writer's lock: a session lock on one dedicated connection, released on the same
 * one (M5 design 5.3). Every git operation on the clone goes through it: writing, reverting, the exchange with
 * GitHub, the CLI at a deploy. Null when the lock did not come within 30 seconds.
 */
export async function withMindLock<T>(db: Db, fn: () => Promise<T>): Promise<T | null> {
  // The pool drizzle was made from (db/client.ts): the lock needs one connection of its own.
  const pool = (db as Db & { $client?: pg.Pool }).$client
  if (!pool) throw new Error('the mind lock needs the database pool')
  const client = await pool.connect()
  try {
    const end = Date.now() + LOCK_WAIT_MS
    for (;;) {
      const r = await client.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('mind-writer')) as ok",
      )
      if (r.rows[0]?.ok) break
      if (Date.now() > end) return null
      await new Promise((res) => setTimeout(res, 200))
    }
    try {
      return await fn()
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('mind-writer'))")
    }
  } finally {
    client.release()
  }
}

/** Every record in the clone (not the proposals folder): its id → file, version, status, scope, text. */
async function recordsOf(mindDir: string): Promise<Map<string, Existing>> {
  const out = new Map<string, Existing>()
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'proposals') await walk(full)
      } else if (e.name.endsWith('.md') && e.name !== 'README.md') {
        const text = await readFile(full, 'utf8')
        const f = MindFrontmatter.safeParse(splitRecord(text).front)
        if (f.success)
          out.set(f.data.id, {
            path: relative(mindDir, full),
            version: f.data.version,
            status: f.data.status,
            scope: f.data.scope,
            text,
          })
      }
    }
  }
  await walk(join(mindDir, 'mind'))
  return out
}

/** The exam scenarios already in the clone, by id (the file's name). */
async function scenariosOf(mindDir: string): Promise<string[]> {
  const files = await readdir(join(mindDir, 'exam', 'scenarios')).catch(() => [] as string[])
  return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
}

/** A proposal M4 wrote whole (no change): its record as a change, so the guard can read it. */
function changeOfContent(p: { path: string; content: string; kind: string; source: string }): {
  change: MindChange
  text: string
  target: string
} | null {
  const target = p.path.replace(/^mind\/proposals\//, 'mind/')
  if (p.kind === 'scenario') {
    let scenario: ExamScenario
    try {
      scenario = ExamScenario.parse(JSON.parse(p.content))
    } catch {
      return null
    }
    return {
      change: {
        file: 'scenario',
        action: 'create',
        recordId: scenario.id,
        type: null,
        scope: 'shared',
        fields: {},
        sections: {},
        scenario,
        section: null,
        baseVersion: null,
        sources: [p.source],
      },
      text: `${JSON.stringify(scenario, null, 2)}\n`,
      target: `exam/scenarios/${scenario.id}.json`,
    }
  }
  const { front, sections } = splitRecord(p.content)
  const f = MindFrontmatter.safeParse(front)
  if (!f.success) return null
  return {
    change: {
      file: 'record',
      action: 'create',
      recordId: f.data.id,
      type: f.data.type,
      scope: f.data.scope,
      fields: {},
      sections: Object.fromEntries(sections),
      scenario: null,
      section: null,
      baseVersion: null,
      sources: f.data.sources,
    },
    text: p.content,
    target,
  }
}

const trailer = (body: string, key: string) =>
  new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(body)?.[1]?.trim() ?? null

/**
 * The names of the clients behind these lessons (M5 design 5.3: «имени клиента из источника урока»): a lesson from a
 * conversation turn knows its order and so its client. Lessons without a client (interview, history cards) give none.
 */
export async function lessonClientNames(db: Db, lessons: LessonRow[]): Promise<string[]> {
  const turns = lessons
    .map((l) => /^conv-turn:(.+)$/.exec(l.sourceRef)?.[1])
    .filter((x): x is string => !!x)
  if (turns.length === 0) return []
  const rows = await db
    .select({ name: lead.clientName })
    .from(convTurn)
    .innerJoin(conversation, eq(conversation.id, convTurn.conversationId))
    .innerJoin(lead, eq(lead.id, conversation.orderId))
    .where(inArray(convTurn.id, turns))
  return namesToHide(...rows.map((r) => r.name))
}

/**
 * The only code that writes into sara-mind, after Boris's «да» (ADR-025, M5 design 5.3). One commit per call, with
 * `Sara-Commit` and `Sara-Proposals` lines so a crash between the commit and the database is repaired from git.
 */
export function createMindWriter(d: {
  db: Db
  mindDir: string
  reindex(): Promise<void>
  secrets?: SecretStore
  git?: GitRunner
  /** The scopes a record may have: `shared` and the configured directions. */
  scopes?: string[]
  /** The names of the clients behind these lessons, which their records must never hold. */
  clientNames?: (lessons: LessonRow[]) => Promise<string[]>
  /** The GitHub address a lost clone is taken again from. */
  remote?: string
  now?: () => Date
}): MindWriter {
  const git = d.git ?? gitBinary
  const now = d.now ?? (() => new Date())
  const namesOf = d.clientNames ?? ((ls: LessonRow[]) => lessonClientNames(d.db, ls))
  const run = (...args: string[]) => git.run(args, d.mindDir)
  const isRepo = async () => (await run('rev-parse', '--is-inside-work-tree')).code === 0
  const head = async () => (await run('rev-parse', 'HEAD')).stdout.trim() || null
  const reindex = () =>
    d.reindex().catch((e) => {
      // The commit and the database are already right; the index catches up on the next write or at start.
      console.error('mind reindex failed', e instanceof Error ? e.message : e)
    })

  /** Sara's commits in the history, newest first: sha, `Sara-Commit` id, the whole message. */
  async function saraCommits(
    range: string[],
    depth: number,
  ): Promise<{ sha: string; id: string; body: string }[]> {
    const log = await run(
      'log',
      `-${depth}`,
      `--author=${SARA_EMAIL}`,
      '--format=%H%x00%B%x1e',
      ...range,
    )
    if (log.code !== 0) return []
    return log.stdout.split('\x1e').flatMap((entry) => {
      const [sha, body = ''] = entry.trim().split('\x00')
      const id = trailer(body, 'Sara-Commit')
      return sha && id && UUID.test(id) ? [{ sha, id, body }] : []
    })
  }

  const event = (
    type: 'mind.written' | 'mind.reverted',
    id: string,
    actor: 'sara' | 'boris',
    payload: Record<string, unknown>,
  ) => ({
    type,
    v: 1,
    entity: { kind: 'mind_commit', id },
    account_id: null,
    actor,
    occurred_at: now().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload,
  })

  /** Marks the lessons of a reverted commit «нет»: what Boris took back is not in the mind any more. */
  async function lessonsReverted(tx: DbOrTx, revertedId: string, revertId: string) {
    const [c] = await tx.select().from(mindCommit).where(eq(mindCommit.id, revertedId))
    const lessonIds = (c?.lessonIds as string[] | undefined) ?? []
    if (lessonIds.length > 0)
      await tx
        .update(lesson)
        .set({ state: 'no', reason: 'откатил' })
        .where(inArray(lesson.id, lessonIds))
    await appendEvent(tx, event('mind.reverted', revertId, 'boris', { reverts: revertedId }))
    return c
  }

  /**
   * Sara's commits whose rows the database lacks (a crash after the commit): written to the database now, as the
   * write or the revert would have. Only her own commits count: a developer's copy of the line is not hers.
   */
  async function reconcile(): Promise<void> {
    for (const c of (await saraCommits([], RECONCILE_DEPTH)).reverse()) {
      const [known] = await d.db
        .select({ id: mindCommit.id })
        .from(mindCommit)
        .where(eq(mindCommit.id, c.id))
      if (known) continue
      const ids = (trailer(c.body, 'Sara-Proposals') ?? '')
        .split(/[\s,]+/)
        .filter((x) => UUID.test(x))
      const reverts = trailer(c.body, 'Sara-Reverts')
      await d.db.transaction(async (tx) => {
        if (reverts && UUID.test(reverts)) {
          const reverted = await lessonsReverted(tx, reverts, c.id)
          await tx.insert(mindCommit).values({
            id: c.id,
            sha: c.sha,
            kind: 'revert',
            proposalIds: reverted?.proposalIds ?? [],
            lessonIds: reverted?.lessonIds ?? [],
            revertsId: reverts,
          })
          return
        }
        const rows = ids.length
          ? await tx
              .update(mindProposal)
              .set({ state: 'accepted', decidedAt: now().toISOString(), commitId: c.id })
              .where(and(inArray(mindProposal.id, ids), eq(mindProposal.state, 'new')))
              .returning({ lessonId: mindProposal.lessonId })
          : []
        const lessonIds = [...new Set(rows.map((r) => r.lessonId).filter((x): x is string => !!x))]
        if (lessonIds.length > 0)
          await tx.update(lesson).set({ commitId: c.id }).where(inArray(lesson.id, lessonIds))
        await tx.insert(mindCommit).values({
          id: c.id,
          sha: c.sha,
          kind: 'accept',
          proposalIds: ids,
          lessonIds,
        })
        await appendEvent(
          tx,
          event('mind.written', c.id, 'sara', { records: ids.length, refused: 0 }),
        )
      })
    }
  }

  /**
   * The clone back to its last commit: an unfinished merge or revert is aborted, staged and changed files go, new
   * files under mind/ and exam/ go, and an index lock left by a dead git is removed (we hold the mind's lock).
   */
  async function discardUncommitted(): Promise<void> {
    const lock = join(d.mindDir, '.git', 'index.lock')
    const st = await stat(lock).catch(() => null)
    if (st && now().getTime() - st.mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true })
    await run('merge', '--abort')
    await run('revert', '--abort')
    await run('cherry-pick', '--abort')
    await run('reset', '-q', '--hard', 'HEAD')
    await run('clean', '-fdq', '--', 'mind', 'exam')
  }

  async function apply(
    proposalIds: string[],
    why: { lessonIds: string[]; batchId: string | null },
  ): ReturnType<MindWriter['apply']> {
    if (!(await isRepo()))
      return { ok: false, reason: 'no_git', detail: 'нет клона разума', refused: [] }
    await reconcile()
    await discardUncommitted()
    const proposals =
      proposalIds.length === 0
        ? []
        : await d.db
            .select()
            .from(mindProposal)
            .where(and(inArray(mindProposal.id, proposalIds), eq(mindProposal.state, 'new')))
    if (proposals.length === 0)
      return (await alreadyWritten(proposalIds)) ?? nothing('нечего записывать')
    const today = new Date(now().getTime() + MSK_MS).toISOString().slice(0, 10)
    const existing = await recordsOf(d.mindDir)
    const existingIds = new Set([...existing.keys(), ...(await scenariosOf(d.mindDir))])
    const lessonIds = [...new Set(proposals.map((p) => p.lessonId).filter((x): x is string => !!x))]
    const lessons = lessonIds.length
      ? ((await d.db.select().from(lesson).where(inArray(lesson.id, lessonIds))) as LessonRow[])
      : []
    const scopes = d.scopes ?? ['shared']

    const refused: Refused[] = []
    const files: { proposalId: string; target: string; text: string }[] = []
    for (const p of proposals) {
      const own = p.lessonId ? (lessons.find((l) => l.id === p.lessonId) ?? null) : null
      let change: MindChange
      let target: string
      let text: string
      if (p.change) {
        change = p.change as MindChange
        const current = existing.get(change.recordId) ?? null
        if (change.action !== 'create' && current && current.scope !== change.scope) {
          refused.push({ proposalId: p.id, reason: `у записи другая область: ${current.scope}` })
          continue
        }
        const r = renderRecord(change, current, today)
        target = r.target
        text = r.text
      } else {
        const m = changeOfContent(p)
        if (!m) {
          refused.push({ proposalId: p.id, reason: 'файл предложения не читается' })
          continue
        }
        change = m.change
        target = m.target
        text = m.change.file === 'scenario' ? m.text : confirmContent(m.text, today)
      }
      const sourceNs = change.sources
        .map((s) => /^lesson:(\d+)$/.exec(s)?.[1])
        .filter((x): x is string => !!x)
        .map(Number)
      const sourceLessons = sourceNs.length
        ? ((await d.db.select().from(lesson).where(inArray(lesson.n, sourceNs))) as LessonRow[])
        : []
      const reason = guardRecord({
        change,
        text,
        lesson: own,
        sourceLessons,
        // Grows as the batch goes: two proposals of one batch never make the same new record.
        existingIds,
        clientNames: await namesOf([...(own ? [own] : []), ...sourceLessons]),
        scopes,
      })
      if (reason) {
        refused.push({ proposalId: p.id, reason })
        continue
      }
      if (change.action === 'create') existingIds.add(change.recordId)
      // The next change of the same record in this batch builds on this one (five portrait sections, one file).
      if (change.file === 'record') {
        const f = MindFrontmatter.safeParse(splitRecord(text).front)
        if (f.success)
          existing.set(change.recordId, {
            path: target,
            version: f.data.version,
            status: f.data.status,
            scope: f.data.scope,
            text,
          })
      }
      files.push({ proposalId: p.id, target, text })
    }

    const commitId = newEventId()
    let sha: string | null = null
    const before = await head()
    if (files.length > 0) {
      for (const f of files) {
        await mkdir(dirname(join(d.mindDir, f.target)), { recursive: true })
        await writeFile(join(d.mindDir, f.target), f.text)
      }
      const targets = [...new Set(files.map((f) => f.target))]
      const added = await run('add', '--', ...targets)
      if (added.code !== 0) {
        await discardUncommitted()
        return { ok: false, reason: 'no_git', detail: added.stderr.slice(0, 300), refused: [] }
      }
      // A file the same as in the clone changes nothing: its proposal is refused, never a commit without changes.
      const changed = new Set(
        (await run('diff', '--cached', '--name-only')).stdout.split('\n').filter(Boolean),
      )
      for (const f of [...files]) {
        if (changed.has(f.target)) continue
        refused.push({ proposalId: f.proposalId, reason: 'в разуме уже так записано' })
        files.splice(files.indexOf(f), 1)
      }
    }
    if (files.length > 0) {
      const ids = proposals.map((p) => p.id).filter((id) => files.some((f) => f.proposalId === id))
      const ns = lessons.map((l) => l.n).sort((a, b) => a - b)
      const names = [
        ...new Set(
          files.map((f) =>
            f.target
              .split('/')
              .pop()
              ?.replace(/\.(md|json)$/, ''),
          ),
        ),
      ]
      const message = `mind: ${names.join(', ')} (Борис: да${ns.length ? `, урок ${ns.join(', ')}` : ''})\n\nSara-Commit: ${commitId}\nSara-Proposals: ${ids.join(' ')}\n`
      const c = await git.run([...SARA_AUTHOR, 'commit', '-q', '-m', message], d.mindDir)
      if (c.code !== 0) {
        await discardUncommitted()
        return { ok: false, reason: 'no_git', detail: c.stderr.slice(0, 300), refused: [] }
      }
      sha = await head()
    } else await discardUncommitted()

    const at = now().toISOString()
    await d.db.transaction(async (tx) => {
      for (const r of refused) {
        await tx
          .update(mindProposal)
          .set({ state: 'declined', decidedAt: at, rejectReason: r.reason })
          .where(eq(mindProposal.id, r.proposalId))
      }
      // A lesson none of whose proposals got in is a «no» with the reason; one with a file written stays «да».
      for (const l of lessons) {
        const mine = proposals.filter((p) => p.lessonId === l.id)
        const allRefused = mine.every((p) => refused.some((r) => r.proposalId === p.id))
        if (mine.length > 0 && allRefused) {
          const why = refused.find((r) => mine.some((p) => p.id === r.proposalId))?.reason
          await tx
            .update(lesson)
            .set({ state: 'no', reason: `не прошло проверку: ${why ?? ''}` })
            .where(eq(lesson.id, l.id))
        }
      }
      if (!sha) return
      const written = files.map((f) => f.proposalId)
      await tx
        .update(mindProposal)
        .set({ state: 'accepted', decidedAt: at, commitId })
        .where(inArray(mindProposal.id, written))
      const writtenLessons = lessons
        .filter((l) => proposals.some((p) => p.lessonId === l.id && written.includes(p.id)))
        .map((l) => l.id)
      if (writtenLessons.length > 0)
        await tx.update(lesson).set({ commitId }).where(inArray(lesson.id, writtenLessons))
      await tx.insert(mindCommit).values({
        id: commitId,
        sha,
        kind: 'accept',
        proposalIds: written,
        lessonIds: writtenLessons,
        mindVersionBefore: before,
      })
      await appendEvent(
        tx,
        event('mind.written', commitId, 'sara', {
          records: files.length,
          refused: refused.length,
          batch_id: why.batchId,
        }),
      )
    })
    if (!sha) return { ...nothing('всё отклонено проверкой'), refused }
    await reindex()
    return {
      ok: true,
      commitId,
      sha,
      mindVersion: sha,
      written: files.map((f) => f.target),
      refused,
    }
  }

  const nothing = (detail: string) => ({
    ok: false as const,
    reason: 'nothing' as const,
    detail,
    refused: [] as Refused[],
  })

  /**
   * The same «да» asked again after its commit was made (a crash, a retry): the answer is that commit, so the caller
   * shows the result and «Отменить» as if nothing had happened.
   */
  async function alreadyWritten(ids: string[]): Promise<WriteResult | null> {
    if (ids.length === 0) return null
    const rows = await d.db
      .select({ state: mindProposal.state, commitId: mindProposal.commitId })
      .from(mindProposal)
      .where(inArray(mindProposal.id, ids))
    const commits = new Set(rows.map((r) => r.commitId))
    const [only] = [...commits]
    if (rows.length !== ids.length || commits.size !== 1 || !only) return null
    if (rows.some((r) => r.state !== 'accepted')) return null
    const [c] = await d.db.select().from(mindCommit).where(eq(mindCommit.id, only))
    if (!c) return null
    return { ok: true, commitId: c.id, sha: c.sha, mindVersion: c.sha, written: [], refused: [] }
  }

  /** Sara's commits after `sha` that touch the same files: what must be undone first. */
  async function laterOnSameFiles(sha: string): Promise<string[]> {
    const files = (await run('show', '--name-only', '--format=', sha)).stdout
      .split('\n')
      .filter(Boolean)
    if (files.length === 0) return []
    const log = await run('log', '--format=%B%x1e', `${sha}..HEAD`, '--', ...files)
    return log.stdout
      .split('\x1e')
      .map((b) => trailer(b, 'Sara-Commit'))
      .filter((x): x is string => !!x)
  }

  async function revert(commitId: string): ReturnType<MindWriter['revert']> {
    if (!(await isRepo())) return { ok: false, reason: 'no_git', detail: 'нет клона разума' }
    await reconcile()
    await discardUncommitted()
    const [c] = await d.db.select().from(mindCommit).where(eq(mindCommit.id, commitId))
    if (c?.kind !== 'accept') return { ok: false, reason: 'unknown', detail: 'нет такой записи' }
    const [done] = await d.db
      .select({ id: mindCommit.id })
      .from(mindCommit)
      .where(eq(mindCommit.revertsId, commitId))
    // Pressed again, or reverted before a crash: the answer is the revert already made.
    if (done) return { ok: true, commitId: done.id }
    // The hash is found by the commit's own line: a hand edit of the history may have changed it.
    const found = (
      await saraCommits(['--fixed-strings', `--grep=Sara-Commit: ${commitId}`], HISTORY_DEPTH)
    )[0]
    const sha = found?.sha ?? c.sha
    const r = await run('revert', '--no-commit', sha)
    if (r.code !== 0) {
      await discardUncommitted()
      const later = await laterOnSameFiles(sha)
      return {
        ok: false,
        reason: 'conflict',
        detail: later.length
          ? `эти записи потом меняли, сначала откати более поздние: ${later.map((id) => id.slice(0, 8)).join(', ')}`
          : 'git не смог откатить',
      }
    }
    const revertId = newEventId()
    const staged = (await run('diff', '--cached', '--quiet')).code !== 0
    let newSha = (await head()) ?? ''
    if (staged) {
      const message = `mind: откат (Борис: отменить)\n\nSara-Commit: ${revertId}\nSara-Reverts: ${commitId}\n`
      const cm = await git.run([...SARA_AUTHOR, 'commit', '-q', '-m', message], d.mindDir)
      if (cm.code !== 0) {
        await discardUncommitted()
        return { ok: false, reason: 'unknown', detail: 'git не смог записать откат' }
      }
      newSha = (await head()) ?? ''
    }
    // Nothing staged: the developers already took these records out, so the revert is only the lessons' «нет».
    await d.db.transaction(async (tx) => {
      await tx.insert(mindCommit).values({
        id: revertId,
        sha: newSha,
        kind: 'revert',
        proposalIds: c.proposalIds,
        lessonIds: c.lessonIds,
        mindVersionBefore: c.sha,
        revertsId: commitId,
      })
      await lessonsReverted(tx, commitId, revertId)
    })
    if (staged) await reindex()
    return { ok: true, commitId: revertId }
  }

  /** The env for one command that talks to GitHub: ssh that gives up, and the key as a 600 file for that time. */
  async function withKey<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const key = d.secrets ? await d.secrets.get('mind_push_key') : null
    if (!key) return fn({ GIT_SSH_COMMAND: SSH })
    const dir = await mkdtemp(join(tmpdir(), 'mind-key-'))
    const file = join(dir, 'key')
    try {
      await writeFile(file, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 })
      return await fn({
        GIT_SSH_COMMAND: `${SSH} -i '${file}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes`,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * The exchange with GitHub (M5 design 5.3): the developers' commits are merged in (a merge, never a rebase: the
   * hashes Boris's «Отменить» points to stay), then Sara's commits are pushed. A conflict aborts the merge and keeps
   * the local commits. An SSH remote without a key is not tried at all and journals nothing (plan B4: «no key»).
   */
  async function sync(o?: { rebuild?: boolean }): ReturnType<MindWriter['sync']> {
    const hasKey = !!(d.secrets && (await d.secrets.get('mind_push_key')))
    const ssh = (remote: string) => remote.startsWith('git@') || remote.startsWith('ssh://')
    if (!(await isRepo())) {
      if (!o?.rebuild) return { pushed: false, pulled: 0, error: 'нет клона разума' }
      const remote = d.remote ?? 'git@github.com:natadvn-hance/sara-mind.git'
      if (ssh(remote) && !hasKey) return { pushed: false, pulled: 0, error: 'no key' }
      const cloned = await withKey((env) =>
        git.run(['clone', '-q', remote, d.mindDir], tmpdir(), env),
      )
      if (cloned.code !== 0) return { pushed: false, pulled: 0, error: 'клон не получился' }
      await replayUnpushed()
    }
    await reconcile()
    await discardUncommitted()
    const remote = (await run('remote', 'get-url', 'origin')).stdout.trim()
    if (ssh(remote) && !hasKey) return { pushed: false, pulled: 0, error: 'no key' }
    return withKey(async (env) => {
      const fetched = await git.run(['fetch', '-q', 'origin'], d.mindDir, env)
      if (fetched.code !== 0) return failed('GitHub не ответил')
      // The developers' commits GitHub has and the clone does not (the merge commit itself is not one of them).
      const pulled = Number(
        (await run('rev-list', '--count', 'HEAD..origin/main')).stdout.trim() || '0',
      )
      const merged = await git.run(
        [...SARA_AUTHOR, 'merge', '--no-edit', '-q', 'origin/main'],
        d.mindDir,
        env,
      )
      if (merged.code !== 0) {
        await discardUncommitted()
        return failed('конфликт слияния с GitHub')
      }
      if (pulled > 0) await reindex()
      const pushed = await git.run(['push', '-q', 'origin', 'HEAD:main'], d.mindDir, env)
      if (pushed.code !== 0) return failed('GitHub не принял отправку', pulled)
      // Pushed are the commits now in the history GitHub has: a row whose commit never got made stays unsent.
      const sent = (await saraCommits(['origin/main'], HISTORY_DEPTH)).map((c) => c.id)
      if (sent.length > 0)
        await d.db
          .update(mindCommit)
          .set({ pushedAt: now().toISOString() })
          .where(and(isNull(mindCommit.pushedAt), inArray(mindCommit.id, sent)))
      await appendEvent(d.db, syncEvent('mind.synced', { pulled }))
      return { pushed: true, pulled, error: null }
    })
  }

  async function failed(error: string, pulled = 0) {
    await appendEvent(d.db, syncEvent('mind.sync_failed', { error }))
    return { pushed: false, pulled, error }
  }

  const syncEvent = (
    type: 'mind.synced' | 'mind.sync_failed',
    payload: Record<string, unknown>,
  ) => ({
    type,
    v: 1,
    entity: { kind: 'mind', id: 'sara-mind' },
    account_id: null,
    actor: 'sara' as const,
    occurred_at: now().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload,
  })

  /**
   * After a fresh clone: Sara's commits that never reached GitHub are made again from the database, writes and
   * reverts in their order, each with its own `Sara-Commit` line. A commit the clone already holds is skipped, and a
   * row gets its new hash only when its commit was made.
   */
  async function replayUnpushed(): Promise<void> {
    const rows = await d.db
      .select()
      .from(mindCommit)
      .where(isNull(mindCommit.pushedAt))
      .orderBy(mindCommit.createdAt)
    const today = new Date(now().getTime() + MSK_MS).toISOString().slice(0, 10)
    const inHistory = async () =>
      new Map((await saraCommits([], HISTORY_DEPTH)).map((c) => [c.id, c.sha] as const))
    for (const c of rows) {
      const known = await inHistory()
      if (known.has(c.id)) continue
      let message: string
      if (c.kind === 'revert') {
        const target = c.revertsId ? known.get(c.revertsId) : undefined
        if (!target) continue
        if ((await run('revert', '--no-commit', target)).code !== 0) {
          await discardUncommitted()
          continue
        }
        message = `mind: откат восстановлен (Борис: отменить)\n\nSara-Commit: ${c.id}\nSara-Reverts: ${c.revertsId}\n`
      } else {
        const ids = (c.proposalIds as string[]) ?? []
        if (ids.length === 0) continue
        const proposals = await d.db
          .select()
          .from(mindProposal)
          .where(inArray(mindProposal.id, ids))
        const existing = await recordsOf(d.mindDir)
        const targets: string[] = []
        for (const p of proposals) {
          const out = p.change
            ? renderRecord(
                p.change as MindChange,
                existing.get((p.change as MindChange).recordId) ?? null,
                today,
              )
            : (() => {
                const m = changeOfContent(p)
                return m
                  ? {
                      target: m.target,
                      text: m.change.file === 'scenario' ? m.text : confirmContent(m.text, today),
                    }
                  : null
              })()
          if (!out) continue
          await mkdir(dirname(join(d.mindDir, out.target)), { recursive: true })
          await writeFile(join(d.mindDir, out.target), out.text)
          targets.push(out.target)
          const f = MindFrontmatter.safeParse(splitRecord(out.text).front)
          if (f.success && p.change)
            existing.set((p.change as MindChange).recordId, {
              path: out.target,
              version: f.data.version,
              status: f.data.status,
              scope: f.data.scope,
              text: out.text,
            })
        }
        if (targets.length === 0) continue
        if ((await run('add', '--', ...new Set(targets))).code !== 0) {
          await discardUncommitted()
          continue
        }
        message = `mind: восстановлено (Борис: да)\n\nSara-Commit: ${c.id}\nSara-Proposals: ${ids.join(' ')}\n`
      }
      if ((await run('diff', '--cached', '--quiet')).code === 0) continue
      const cm = await git.run([...SARA_AUTHOR, 'commit', '-q', '-m', message], d.mindDir)
      if (cm.code !== 0) {
        await discardUncommitted()
        continue
      }
      const sha = await head()
      if (sha) await d.db.update(mindCommit).set({ sha }).where(eq(mindCommit.id, c.id))
    }
  }

  const locked = { ok: false as const, reason: 'locked' as const, detail: 'разум занят' }
  return {
    async apply(proposalIds, why) {
      const r = await withMindLock(d.db, () => apply(proposalIds, why))
      return r ?? { ...locked, refused: [] }
    },
    async revert(commitId) {
      return (await withMindLock(d.db, () => revert(commitId))) ?? locked
    },
    async sync(o) {
      return (
        (await withMindLock(d.db, () => sync(o))) ?? {
          pushed: false,
          pulled: 0,
          error: 'разум занят',
        }
      )
    },
  }
}
