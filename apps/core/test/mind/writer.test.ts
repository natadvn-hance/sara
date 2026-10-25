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
import type { MindChange } from '../../src/school/types'
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
async function yesLesson(
  i: number,
  o: { sim?: boolean; source?: string; boris?: string } = {},
): Promise<string> {
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
        borisText: o.boris ?? 'Цену скажу после созвона',
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

/** A lesson Boris said «да» to with one change of any kind; its proposal id. */
async function yesChange(ref: string, change: MindChange): Promise<string> {
  const l = await createLesson(db, {
    source: 'teacher',
    sourceRef: ref,
    scope: 'shared',
    topic: null,
    tone: null,
    questionType: null,
    clientText: null,
    before: null,
    after: null,
    insight: 'вывод учителя',
    kind: 'voice',
    state: 'ready',
    inPlace: false,
    sim: false,
    modelCallId: null,
    changes: [change],
  })
  await decideLesson(db, l.id, { decision: 'yes' })
  const [p] = await db.select().from(mindProposal).where(eq(mindProposal.lessonId, l.id))
  return p?.id ?? ''
}

const portrait = (section: string, text: string): MindChange => ({
  file: 'record',
  action: 'update',
  recordId: 's-portrait',
  type: 'speech',
  scope: 'shared',
  fields: { title: 'Портрет речи' },
  sections: { [section]: text },
  scenario: null,
  section,
  baseVersion: null,
  sources: ['e-h-1'],
})

const scenario = (id: string): MindChange => ({
  file: 'scenario',
  action: 'create',
  recordId: id,
  type: null,
  scope: 'shared',
  fields: {},
  sections: {},
  scenario: {
    id,
    title: 'Торг',
    source: { kind: 'history', ref: 'chat-1' },
    tags: {
      question_type: null,
      stage: 'talking',
      tone: 'bargaining',
      archetype: null,
      hard: false,
    },
    golden: true,
    order: { title: 'Сайт', category: 'Сайты', text: 'Сайт', budget_text: null, city: 'Краснодар' },
    client_name: null,
    bid: null,
    messages: [{ author: 'client', text: 'Дорого', at: '2026-10-20T10:00:00.000Z' }],
    state: { owner: 'sara', owner_reason: null, boris_note: null },
    now: '2026-10-20T10:01:00.000Z',
    expect: { move: 'reply', must_not_contain: [], must_mention_any: [], boris_reply: 'Почему?' },
    rubric: null,
  },
  section: null,
  baseVersion: null,
  sources: ['history:chat-1'],
})

function writer(
  dir: string,
  o: {
    git?: typeof gitBinary
    clientNames?: () => Promise<string[]>
    reindex?: () => Promise<void>
  } = {},
) {
  let reindexed = 0
  const w = createMindWriter({
    db,
    mindDir: dir,
    reindex:
      o.reindex ??
      (async () => {
        reindexed++
      }),
    scopes: ['shared', 'hance'],
    git: o.git,
    clientNames: o.clientNames,
  })
  return { w, reindexed: () => reindexed }
}

// Each test runs git many times: on a loaded machine (CI shares it) 5 seconds is too little.
describe('the mind writer', { timeout: 30_000 }, () => {
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
    const first = await w.apply([id], { lessonIds: [], batchId: null })
    // Asked again, the answer is the commit already made: the caller shows it and «Отменить».
    expect(await w.apply([id], { lessonIds: [], batchId: null })).toMatchObject({
      ok: true,
      commitId: first.ok ? first.commitId : 'none',
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
    const made = /Sara-Commit: (\S+)/.exec(git(dir, 'log', '-1', '--format=%B'))?.[1]
    expect(await writer(dir).w.apply([id], { lessonIds: [], batchId: null })).toMatchObject({
      ok: true,
      commitId: made,
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

  it('FR-MIND-3: a client called Борис does not stop the examples, his other name still does', async () => {
    const dir = await clone()
    const good = await yesLesson(1)
    const bad = await yesLesson(2, { boris: 'Петров, цену скажу после созвона' })
    const r = await writer(dir, { clientNames: async () => ['Борис Петров'] }).w.apply(
      [good, bad],
      {
        lessonIds: [],
        batchId: null,
      },
    )
    if (!r.ok) throw new Error(r.detail)
    expect(r.written).toHaveLength(1)
    expect(r.refused).toEqual([{ proposalId: bad, reason: expect.stringMatching(/имя клиента/) }])
  })

  it('FR-SPEECH-1: two sections of one record in one batch both reach the file', async () => {
    const dir = await clone()
    const a = await yesChange('t:1', portrait('Форма', '- Коротко [e-h-1]'))
    const b = await yesChange('t:2', portrait('Словарь', '- «Давайте созвонимся» [e-h-1]'))
    const r = await writer(dir).w.apply([a, b], { lessonIds: [], batchId: null })
    if (!r.ok) throw new Error(r.detail)
    const text = await readFile(join(dir, 'mind/shared/speech/s-portrait.md'), 'utf8')
    expect(text).toContain('## Форма\n- Коротко [e-h-1]')
    expect(text).toContain('## Словарь\n- «Давайте созвонимся» [e-h-1]')
    expect(text).toContain('version: 2')
    expect(commits(dir)).toBe('2')
  })

  it('NFR-REL-3: a file staged by a crash never rides along in the next commit', async () => {
    const dir = await clone()
    await mkdir(join(dir, 'mind/shared/knowledge'), { recursive: true })
    await writeFile(join(dir, 'mind/shared/knowledge/k-half.md'), 'половина')
    git(dir, 'add', 'mind/shared/knowledge/k-half.md')
    const r = await writer(dir).w.apply([await yesLesson(1)], { lessonIds: [], batchId: null })
    if (!r.ok) throw new Error(r.detail)
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe(r.written[0])
    expect(existsSync(join(dir, 'mind/shared/knowledge/k-half.md'))).toBe(false)
  })

  it('FR-TRAIN-8: a scenario is written under its own id, never over another or elsewhere', async () => {
    const dir = await clone()
    const first = await yesChange('s:1', scenario('x-g-1'))
    const again = await yesChange('s:2', scenario('x-g-1'))
    const elsewhere = await yesChange('s:3', { ...scenario('x-g-2'), recordId: '../../x' })
    const r = await writer(dir).w.apply([first, again, elsewhere], { lessonIds: [], batchId: null })
    if (!r.ok) throw new Error(r.detail)
    expect(r.written).toEqual(['exam/scenarios/x-g-1.json'])
    expect(r.refused.map((x) => x.reason).sort()).toEqual([
      'номер сценария не совпадает с файлом',
      'сценарий с таким номером уже есть',
    ])
  })

  it('FR-MIND-3: an update never moves a record to another scope', async () => {
    const dir = await clone()
    await writer(dir).w.apply([await yesChange('t:1', portrait('Форма', '- Коротко [e-h-1]'))], {
      lessonIds: [],
      batchId: null,
    })
    const other = await yesChange('t:2', {
      ...portrait('Темп', '- Быстро [e-h-1]'),
      scope: 'hance',
    })
    const r = await writer(dir).w.apply([other], { lessonIds: [], batchId: null })
    expect(r).toMatchObject({ ok: false, reason: 'nothing' })
    expect(r.refused[0]?.reason).toMatch(/другая область/)
  })

  it('NFR-REL-3: a failed reindex never fails a write that is already committed', async () => {
    const dir = await clone()
    const r = await writer(dir, {
      reindex: async () => {
        throw new Error('index is down')
      },
    }).w.apply([await yesLesson(1)], { lessonIds: [], batchId: null })
    expect(r.ok).toBe(true)
  })
})
