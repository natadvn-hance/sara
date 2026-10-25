import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { ExamScenario, MindFrontmatter, newEventId } from '@sara/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type pg from 'pg'
import type { Db } from '../db/client'
import { lesson, mindCommit, mindProposal } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { LessonRow, MindChange, MindWriter, Refused } from '../school/types'
import type { SecretStore } from '../secrets/store'
import { type GitRunner, gitBinary, SARA_AUTHOR } from './git'
import { guardRecord } from './guard'
import { confirmContent, renderRecord, splitRecord } from './render'

const MSK_MS = 3 * 60 * 60_000
/** How long a writer waits for another one to finish (M5 design 5.3). */
const LOCK_WAIT_MS = 30_000
/** How many recent commits are read back to repair a crash between a commit and the database. */
const RECONCILE_DEPTH = 50

type Existing = { path: string; version: number; status: string; text: string }

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

/** Every record in the clone (not the proposals folder): its id → file, version, status, text. */
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
            text,
          })
      }
    }
  }
  await walk(join(mindDir, 'mind'))
  return out
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
      text: p.content,
      target,
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
  /** The names of clients a record must never hold. */
  clientNames?: () => Promise<string[]>
  /** The GitHub address a lost clone is taken again from. */
  remote?: string
  now?: () => Date
}): MindWriter {
  const git = d.git ?? gitBinary
  const now = d.now ?? (() => new Date())
  const run = (...args: string[]) => git.run(args, d.mindDir)
  const isRepo = async () => (await run('rev-parse', '--is-inside-work-tree')).code === 0
  const head = async () => (await run('rev-parse', 'HEAD')).stdout.trim() || null

  /** Commits made by Sara whose rows the database lacks (a crash after the commit): written to the database now. */
  async function reconcile(): Promise<void> {
    const log = await run('log', `-${RECONCILE_DEPTH}`, '--format=%H%x00%B%x1e')
    if (log.code !== 0) return
    for (const entry of log.stdout.split('\x1e')) {
      const [sha, body = ''] = entry.trim().split('\x00')
      const commitId = trailer(body, 'Sara-Commit')
      if (!sha || !commitId) continue
      const [known] = await d.db
        .select({ id: mindCommit.id })
        .from(mindCommit)
        .where(eq(mindCommit.id, commitId))
      if (known) continue
      const ids = (trailer(body, 'Sara-Proposals') ?? '').split(/[\s,]+/).filter(Boolean)
      const reverts = trailer(body, 'Sara-Reverts')
      await d.db.transaction(async (tx) => {
        await tx.insert(mindCommit).values({
          id: commitId,
          sha,
          kind: reverts ? 'revert' : 'accept',
          proposalIds: ids,
          revertsId: reverts,
        })
        if (ids.length > 0 && !reverts) {
          const rows = await tx
            .update(mindProposal)
            .set({ state: 'accepted', decidedAt: now().toISOString(), commitId })
            .where(and(inArray(mindProposal.id, ids), eq(mindProposal.state, 'new')))
            .returning({ lessonId: mindProposal.lessonId })
          const lessonIds = rows.map((r) => r.lessonId).filter((x): x is string => !!x)
          if (lessonIds.length > 0)
            await tx.update(lesson).set({ commitId }).where(inArray(lesson.id, lessonIds))
        }
      })
    }
  }

  async function discardUncommitted(): Promise<void> {
    await run('checkout', 'HEAD', '--', '.')
    await run('clean', '-fd', '--', 'mind', 'exam')
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
      return { ok: false, reason: 'nothing', detail: 'нечего записывать', refused: [] }
    const today = new Date(now().getTime() + MSK_MS).toISOString().slice(0, 10)
    const existing = await recordsOf(d.mindDir)
    const existingIds = new Set(existing.keys())
    const lessonIds = [...new Set(proposals.map((p) => p.lessonId).filter((x): x is string => !!x))]
    const lessons = lessonIds.length
      ? ((await d.db.select().from(lesson).where(inArray(lesson.id, lessonIds))) as LessonRow[])
      : []
    const names = d.clientNames ? await d.clientNames() : []
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
        clientNames: names,
        scopes,
      })
      if (reason) {
        refused.push({ proposalId: p.id, reason })
        continue
      }
      if (change.action === 'create') existingIds.add(change.recordId)
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
      await run('add', '--', ...files.map((f) => f.target))
      const ids = proposals.map((p) => p.id).filter((id) => files.some((f) => f.proposalId === id))
      const ns = lessons.map((l) => l.n).sort((a, b) => a - b)
      const message = `mind: ${files
        .map((f) =>
          f.target
            .split('/')
            .pop()
            ?.replace(/\.(md|json)$/, ''),
        )
        .join(
          ', ',
        )} (Борис: да${ns.length ? `, урок ${ns.join(', ')}` : ''})\n\nSara-Commit: ${commitId}\nSara-Proposals: ${ids.join(' ')}\n`
      const c = await git.run([...SARA_AUTHOR, 'commit', '-q', '-m', message], d.mindDir)
      if (c.code !== 0) {
        await discardUncommitted()
        return { ok: false, reason: 'no_git', detail: c.stderr.slice(0, 300), refused: [] }
      }
      sha = await head()
    }

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
      await appendEvent(tx, {
        type: 'mind.written',
        v: 1,
        entity: { kind: 'mind_commit', id: commitId },
        account_id: null,
        actor: 'sara',
        occurred_at: at,
        causation_id: null,
        correlation_id: newEventId(),
        reason: null,
        payload: { records: files.length, refused: refused.length, batch_id: why.batchId },
      })
    })
    if (!sha) return { ok: false, reason: 'nothing', detail: 'всё отклонено проверкой', refused }
    await d.reindex()
    return {
      ok: true,
      commitId,
      sha,
      mindVersion: sha,
      written: files.map((f) => f.target),
      refused,
    }
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
    if (!c || c.kind !== 'accept')
      return { ok: false, reason: 'unknown', detail: 'нет такой записи' }
    const [done] = await d.db
      .select({ id: mindCommit.id })
      .from(mindCommit)
      .where(eq(mindCommit.revertsId, commitId))
    if (done) return { ok: false, reason: 'unknown', detail: 'уже откачено' }
    // The hash is found by the commit's own line: a hand edit of the history may have changed it.
    const found = (
      await run('log', '--format=%H', '--fixed-strings', '--grep', `Sara-Commit: ${commitId}`)
    ).stdout
      .split('\n')
      .find(Boolean)
    const sha = found ?? c.sha
    const r = await run('revert', '--no-commit', sha)
    if (r.code !== 0) {
      await run('revert', '--abort')
      await discardUncommitted()
      const later = await laterOnSameFiles(sha)
      return {
        ok: false,
        reason: 'conflict',
        detail: later.length
          ? `эти записи потом меняли ещё ${later.length} раз, сначала откати более поздние`
          : 'git не смог откатить',
      }
    }
    const revertId = newEventId()
    const message = `mind: откат (Борис: отменить)\n\nSara-Commit: ${revertId}\nSara-Reverts: ${commitId}\n`
    const cm = await git.run([...SARA_AUTHOR, 'commit', '-q', '-m', message], d.mindDir)
    if (cm.code !== 0) {
      await discardUncommitted()
      return { ok: false, reason: 'no_git', detail: cm.stderr.slice(0, 300) }
    }
    const newSha = (await head()) ?? ''
    const at = now().toISOString()
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
      const lessonIds = (c.lessonIds as string[]) ?? []
      if (lessonIds.length > 0)
        await tx
          .update(lesson)
          .set({ state: 'no', reason: 'откатил' })
          .where(inArray(lesson.id, lessonIds))
      await appendEvent(tx, {
        type: 'mind.reverted',
        v: 1,
        entity: { kind: 'mind_commit', id: revertId },
        account_id: null,
        actor: 'boris',
        occurred_at: at,
        causation_id: null,
        correlation_id: newEventId(),
        reason: null,
        payload: { reverts: commitId },
      })
    })
    await d.reindex()
    return { ok: true, commitId: revertId }
  }

  /** The key for GitHub, as a 600 file for the time of one command; null without a key. */
  async function withKey<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const key = d.secrets ? await d.secrets.get('mind_push_key') : null
    if (!key) return fn({})
    const dir = await mkdtemp(join(tmpdir(), 'mind-key-'))
    const file = join(dir, 'key')
    try {
      await writeFile(file, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 })
      return await fn({
        GIT_SSH_COMMAND: `ssh -i ${file} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes`,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * The exchange with GitHub (M5 design 5.3): the developers' commits are merged in (a merge, never a rebase: the
   * hashes Boris's «Отменить» points to stay), then Sara's commits are pushed. A conflict aborts the merge and keeps
   * the local commits; without a key for an SSH remote the push is skipped quietly.
   */
  async function sync(o?: { rebuild?: boolean }): ReturnType<MindWriter['sync']> {
    if (!(await isRepo())) {
      if (!o?.rebuild) return { pushed: false, pulled: 0, error: 'нет клона разума' }
      const remote = d.remote ?? 'git@github.com:natadvn-hance/sara-mind.git'
      const cloned = await withKey((env) =>
        git.run(['clone', '-q', remote, d.mindDir], tmpdir(), env),
      )
      if (cloned.code !== 0) return { pushed: false, pulled: 0, error: 'клон не получился' }
      await replayUnpushed()
    }
    await reconcile()
    await discardUncommitted()
    const remote = (await run('remote', 'get-url', 'origin')).stdout.trim()
    const needsKey = remote.startsWith('git@') || remote.startsWith('ssh://')
    const hasKey = !!(d.secrets && (await d.secrets.get('mind_push_key')))
    return withKey(async (env) => {
      const fetched = await git.run(['fetch', '-q', 'origin'], d.mindDir, env)
      if (fetched.code !== 0) return failed('GitHub не ответил')
      const before = await head()
      const merged = await git.run(
        [...SARA_AUTHOR, 'merge', '--no-edit', '-q', 'origin/main'],
        d.mindDir,
        env,
      )
      if (merged.code !== 0) {
        await run('merge', '--abort')
        await discardUncommitted()
        return failed('конфликт слияния с GitHub')
      }
      const pulled = Number(
        (await run('rev-list', '--count', `${before ?? 'HEAD'}..HEAD`)).stdout.trim() || '0',
      )
      if (pulled > 0) await d.reindex()
      if (needsKey && !hasKey) return { pushed: false, pulled, error: 'no key' }
      const pushed = await git.run(['push', '-q', 'origin', 'HEAD:main'], d.mindDir, env)
      if (pushed.code !== 0) return failed('GitHub не принял отправку', pulled)
      const at = now().toISOString()
      await d.db.update(mindCommit).set({ pushedAt: at }).where(isNull(mindCommit.pushedAt))
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
   * After a fresh clone: Sara's commits that never reached GitHub are made again from the database, in order, with
   * their own `Sara-Commit` lines (the proposals keep their change or content).
   */
  async function replayUnpushed(): Promise<void> {
    const rows = await d.db
      .select()
      .from(mindCommit)
      .where(and(eq(mindCommit.kind, 'accept'), isNull(mindCommit.pushedAt)))
      .orderBy(mindCommit.createdAt)
    const today = new Date(now().getTime() + MSK_MS).toISOString().slice(0, 10)
    for (const c of rows) {
      const ids = (c.proposalIds as string[]) ?? []
      if (ids.length === 0) continue
      const proposals = await d.db.select().from(mindProposal).where(inArray(mindProposal.id, ids))
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
      }
      if (targets.length === 0) continue
      await run('add', '--', ...targets)
      const message = `mind: восстановлено (Борис: да)\n\nSara-Commit: ${c.id}\nSara-Proposals: ${ids.join(' ')}\n`
      await git.run([...SARA_AUTHOR, 'commit', '-q', '-m', message], d.mindDir)
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
