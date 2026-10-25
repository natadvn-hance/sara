import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, lesson, mindCommit, mindProposal } from '../../src/db/schema'
import { gitBinary } from '../../src/mind/git'
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

async function clone(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sara-mind-'))
  git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'README.md'), 'разум\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'start')
  return dir
}
const commits = (dir: string) => git(dir, 'rev-list', '--count', 'HEAD').trim()

/** A lesson Boris said «да» to, with one example proposal; its proposal id. */
async function yesLesson(i: number, o: { sim?: boolean; source?: string } = {}): Promise<string> {
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
    sim: o.sim ?? false,
    modelCallId: null,
    changes: [
      exampleChange({
        scope: 'shared',
        topic: 'price',
        tone: 'doubt',
        stage: null,
        clientText: 'Сколько стоит?',
        borisText: 'Цену скажу после созвона',
        insight: 'Цену не называть до созвона',
        source: o.source ?? `edit:conv-turn:${i}`,
        names: [],
      }),
    ],
  })
  await decideLesson(db, l.id, { decision: 'yes' })
  const [p] = await db.select().from(mindProposal).where(eq(mindProposal.lessonId, l.id))
  return p?.id ?? ''
}

function writer(dir: string, o: { git?: typeof gitBinary } = {}) {
  let reindexed = 0
  const w = createMindWriter({
    db,
    mindDir: dir,
    reindex: async () => {
      reindexed++
    },
    scopes: ['shared'],
    ...o,
  })
  return { w, reindexed: () => reindexed }
}

describe('the mind writer', () => {
  it('FR-MIND-3: yes writes the file, commits once and reindexes', async () => {
    const dir = await clone()
    const id = await yesLesson(1)
    const { w, reindexed } = writer(dir)
    const r = await w.apply([id], { lessonIds: [], batchId: null })
    if (!r.ok) throw new Error(r.detail)
    const [p] = await db.select().from(mindProposal)
    const file = r.written[0] ?? ''
    expect(file).toMatch(/^mind\/shared\/speech\/examples\/e-l-\d+\.md$/)
    expect(await readFile(join(dir, file), 'utf8')).toContain('status: "confirmed"')
    expect(commits(dir)).toBe('2')
    const log = git(dir, 'log', '-1', '--format=%an%n%B')
    expect(log).toContain('Сара')
    expect(log).toContain(`Sara-Commit: ${r.commitId}`)
    expect(log).toContain(`Sara-Proposals: ${id}`)
    expect(p).toMatchObject({ state: 'accepted', commitId: r.commitId })
    const [l] = await db.select().from(lesson)
    expect(l?.commitId).toBe(r.commitId)
    const [c] = await db.select().from(mindCommit)
    expect(c).toMatchObject({ id: r.commitId, sha: r.sha, kind: 'accept' })
    expect(reindexed()).toBe(1)
    expect((await db.select().from(event)).map((e) => e.type)).toContain('mind.written')
  })

  it('FR-MIND-3: a proposal already accepted is not written twice', async () => {
    const dir = await clone()
    const id = await yesLesson(1)
    const { w } = writer(dir)
    await w.apply([id], { lessonIds: [], batchId: null })
    expect(await w.apply([id], { lessonIds: [], batchId: null })).toMatchObject({
      ok: false,
      reason: 'nothing',
    })
    expect(commits(dir)).toBe('2')
  })

  it('NFR-REL-3: a crash after the commit and before the database is repaired from Sara-Commit, with no second commit', async () => {
    const dir = await clone()
    const id = await yesLesson(1)
    const crashing = {
      run: async (args: string[], cwd: string) => {
        const r = await gitBinary.run(args, cwd)
        if (args.includes('commit')) throw new Error('the core died here')
        return r
      },
    }
    await expect(
      writer(dir, { git: crashing }).w.apply([id], { lessonIds: [], batchId: null }),
    ).rejects.toThrow()
    expect(commits(dir)).toBe('2')
    expect((await db.select().from(mindProposal))[0]?.state).toBe('new')
    expect(await writer(dir).w.apply([id], { lessonIds: [], batchId: null })).toMatchObject({
      reason: 'nothing',
    })
    expect(commits(dir)).toBe('2')
    expect((await db.select().from(mindProposal))[0]?.state).toBe('accepted')
    expect(await db.select().from(mindCommit)).toHaveLength(1)
  })

  it('NFR-REL-3: files left uncommitted by a crash are dropped and written again once', async () => {
    const dir = await clone()
    const id = await yesLesson(1)
    await mkdir(join(dir, 'mind/shared/knowledge'), { recursive: true })
    await writeFile(join(dir, 'mind/shared/knowledge/k-half.md'), 'половина')
    await writeFile(join(dir, 'README.md'), 'испорчено')
    await writer(dir).w.apply([id], { lessonIds: [], batchId: null })
    expect(existsSync(join(dir, 'mind/shared/knowledge/k-half.md'))).toBe(false)
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('разум\n')
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('FR-MIND-3: two writers at once make two commits one after another', async () => {
    const dir = await clone()
    const a = await yesLesson(1)
    const b = await yesLesson(2)
    const [ra, rb] = await Promise.all([
      writer(dir).w.apply([a], { lessonIds: [], batchId: null }),
      writer(dir).w.apply([b], { lessonIds: [], batchId: null }),
    ])
    expect([ra.ok, rb.ok]).toEqual([true, true])
    expect(commits(dir)).toBe('3')
  })

  it('FR-TRAIN-9: one refused record does not stop the others', async () => {
    const dir = await clone()
    const good = await yesLesson(1)
    const bad = await yesLesson(2, { source: 'sim:d1:3' })
    const r = await writer(dir).w.apply([good, bad], { lessonIds: [], batchId: null })
    if (!r.ok) throw new Error(r.detail)
    expect(r.written).toHaveLength(1)
    expect(r.refused).toEqual([
      { proposalId: bad, reason: expect.stringMatching(/сгенерированного/) },
    ])
    const rows = await db.select().from(mindProposal)
    expect(rows.find((p) => p.id === bad)).toMatchObject({ state: 'declined' })
    const ls = await db.select().from(lesson)
    expect(ls.map((l) => l.state).sort()).toEqual(['no', 'yes'])
  })

  it('FR-MIND-3: without a git clone nothing is written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'no-git-'))
    const id = await yesLesson(1)
    expect(await writer(dir).w.apply([id], { lessonIds: [], batchId: null })).toMatchObject({
      ok: false,
      reason: 'no_git',
    })
  })
})
