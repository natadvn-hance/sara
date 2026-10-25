import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, lesson, mindCommit, mindProposal } from '../../src/db/schema'
import { createMindWriter } from '../../src/mind/writer'
import { exampleChange } from '../../src/school/lessons/records'
import { createLesson, decideLesson } from '../../src/school/lessons/store'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: dir,
    encoding: 'utf8',
  })

/** A «GitHub» (a bare repository in a folder) and the server's clone of it. */
async function remoteAndClone(): Promise<{ remote: string; dir: string; dev: string }> {
  const remote = await mkdtemp(join(tmpdir(), 'gh-'))
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  const dev = await mkdtemp(join(tmpdir(), 'dev-'))
  git(dev, 'clone', '-q', remote, '.')
  await writeFile(join(dev, 'README.md'), 'разум\n')
  git(dev, 'add', '.')
  git(dev, 'commit', '-q', '-m', 'start')
  git(dev, 'push', '-q', 'origin', 'HEAD:main')
  const dir = await mkdtemp(join(tmpdir(), 'server-'))
  git(dir, 'clone', '-q', remote, '.')
  return { remote, dir, dev }
}

async function yesLesson(i: number): Promise<string> {
  const l = await createLesson(db, {
    source: 'edit',
    sourceRef: `conv-turn:${i}`,
    scope: 'shared',
    topic: 'price',
    tone: 'doubt',
    questionType: null,
    clientText: 'Сколько стоит?',
    before: 'От 50 000',
    after: 'Цену скажу после созвона',
    insight: 'Цену не называть до созвона',
    kind: 'procedure',
    state: 'ready',
    inPlace: false,
    sim: false,
    modelCallId: null,
    changes: [
      exampleChange({
        scope: 'shared',
        topic: 'price',
        tone: 'doubt',
        stage: null,
        clientText: 'Сколько стоит?',
        borisText: `Цену скажу после созвона (${i})`,
        insight: 'Цену не называть до созвона',
        source: `edit:conv-turn:${i}`,
        names: [],
      }),
    ],
  })
  await decideLesson(db, l.id, { decision: 'yes' })
  const [p] = await db.select().from(mindProposal).where(eq(mindProposal.lessonId, l.id))
  return p?.id ?? ''
}

const writerAt = (dir: string, remote?: string) => {
  let reindexed = 0
  const w = createMindWriter({
    db,
    mindDir: dir,
    scopes: ['shared'],
    remote,
    reindex: async () => {
      reindexed++
    },
  })
  return { w, reindexed: () => reindexed }
}

describe('revert and the exchange with GitHub', () => {
  it('FR-MIND-3: one button brings the previous mind version back', async () => {
    const { dir } = await remoteAndClone()
    const { w } = writerAt(dir)
    const r = await w.apply([await yesLesson(1)], { lessonIds: [], batchId: null })
    if (!r.ok) throw new Error(r.detail)
    const back = await w.revert(r.commitId)
    expect(back.ok).toBe(true)
    expect(git(dir, 'ls-files', 'mind')).toBe('')
    expect((await db.select().from(lesson))[0]).toMatchObject({ state: 'no', reason: 'откатил' })
    expect(await db.select().from(mindCommit).where(eq(mindCommit.kind, 'revert'))).toHaveLength(1)
    expect((await db.select().from(event)).map((e) => e.type)).toContain('mind.reverted')
    expect(await w.revert(r.commitId)).toMatchObject({ ok: false })
  })

  it('FR-MIND-3: a revert under later changes refuses and names them', async () => {
    const { dir } = await remoteAndClone()
    const { w } = writerAt(dir)
    const r = await w.apply([await yesLesson(1)], { lessonIds: [], batchId: null })
    if (!r.ok) throw new Error(r.detail)
    const file = join(dir, r.written[0] ?? '')
    await writeFile(file, `${await readFile(file, 'utf8')}\nправка разработки\n`)
    git(dir, 'commit', '-qam', 'later\n\nSara-Commit: 0199d0b0-0000-7000-8000-00000000aaaa')
    const back = await w.revert(r.commitId)
    expect(back).toMatchObject({ ok: false, reason: 'conflict' })
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('FR-MIND-3: commits reach GitHub at night', async () => {
    const { remote, dir } = await remoteAndClone()
    const { w } = writerAt(dir)
    await w.apply([await yesLesson(1)], { lessonIds: [], batchId: null })
    expect(await w.sync()).toEqual({ pushed: true, pulled: 0, error: null })
    expect(git(remote, 'log', '-1', '--format=%an', 'main').trim()).toBe('Сара')
    const [c] = await db.select().from(mindCommit)
    expect(c?.pushedAt).not.toBeNull()
  })

  it("FR-MIND-3: after a merge with a developer's commit «Отменить» still reverts yesterday's batch", async () => {
    const { dir, dev } = await remoteAndClone()
    const { w, reindexed } = writerAt(dir)
    const r = await w.apply([await yesLesson(1)], { lessonIds: [], batchId: null })
    if (!r.ok) throw new Error(r.detail)
    await writeFile(join(dev, 'NOTES.md'), 'от разработки\n')
    git(dev, 'add', '.')
    git(dev, 'commit', '-q', '-m', 'dev')
    git(dev, 'push', '-q', 'origin', 'HEAD:main')
    expect(await w.sync()).toEqual({ pushed: true, pulled: 1, error: null })
    expect(reindexed()).toBeGreaterThanOrEqual(2)
    expect(git(dir, 'log', '--format=%H').includes(r.sha)).toBe(true)
    expect((await w.revert(r.commitId)).ok).toBe(true)
  })

  it('FR-MIND-3: a merge conflict keeps the local commits and is journaled', async () => {
    const { dir, dev } = await remoteAndClone()
    const { w } = writerAt(dir)
    await writeFile(join(dir, 'README.md'), 'сервер\n')
    git(dir, 'commit', '-qam', 'server')
    await writeFile(join(dev, 'README.md'), 'разработка\n')
    git(dev, 'commit', '-qam', 'dev')
    git(dev, 'push', '-q', 'origin', 'HEAD:main')
    const r = await w.sync()
    expect(r).toMatchObject({ pushed: false, error: 'конфликт слияния с GitHub' })
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('server')
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect((await db.select().from(event)).map((e) => e.type)).toContain('mind.sync_failed')
  })

  it('NFR-REL-2: a lost clone is rebuilt from GitHub and the unsent commits', async () => {
    const { remote, dir } = await remoteAndClone()
    const { w } = writerAt(dir, remote)
    const r = await w.apply([await yesLesson(1)], { lessonIds: [], batchId: null })
    if (!r.ok) throw new Error(r.detail)
    await rm(dir, { recursive: true, force: true })
    const again = await w.sync({ rebuild: true })
    expect(again).toMatchObject({ pushed: true })
    expect(git(dir, 'ls-files', 'mind').trim()).toBe(r.written[0])
    expect(git(dir, 'log', '-1', '--format=%B')).toContain(`Sara-Commit: ${r.commitId}`)
  })
})
