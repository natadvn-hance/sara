import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'
import { count } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, mindIndex } from '../../src/db/schema'
import {
  folderMindVersion,
  indexedMindVersion,
  mindStateProblem,
  readMindState,
} from '../../src/exam/mindState'
import { appendEvent } from '../../src/journal/journal'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'exam-mind-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  return dir
}

async function indexed(version: string, at: string) {
  await appendEvent(db, {
    type: 'mind.indexed',
    v: 1,
    entity: { kind: 'mind', id: version },
    account_id: null,
    actor: 'system',
    occurred_at: at,
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { mind_version: version, records: 1, errors: 0 },
  })
}

describe('the mind the exam runs against', () => {
  it('FR-TRAIN-8: the version of the folder is its commit, else a hash of its records, and a missing or empty folder is «empty»', async () => {
    expect(await folderMindVersion(join(tmpdir(), 'exam-no-such-mind'))).toBe('empty')
    expect(await folderMindVersion(await folder({}))).toBe('empty')
    const a = await folder({ 'mind/shared/knowledge/k-a.md': 'один' })
    const same = await folder({ 'mind/shared/knowledge/k-a.md': 'один' })
    const other = await folder({ 'mind/shared/knowledge/k-a.md': 'два' })
    expect(await folderMindVersion(a)).toMatch(/^[0-9a-f]{12}$/)
    expect(await folderMindVersion(same)).toBe(await folderMindVersion(a))
    expect(await folderMindVersion(other)).not.toBe(await folderMindVersion(a))
    // Only the trees of the index count: a README, the proposals and the exam scenarios are not the mind.
    const noise = await folder({
      'mind/shared/knowledge/k-a.md': 'один',
      'mind/shared/README.md': 'оглавление',
      'mind/proposals/k-b.md': 'предложение',
      'exam/scenarios/x-a.json': '{}',
    })
    expect(await folderMindVersion(noise)).toBe(await folderMindVersion(a))
  })

  it('FR-TRAIN-8: the commit of a clone is its version', async () => {
    const sha = 'a'.repeat(40)
    const detached = await folder({ '.git/HEAD': `${sha}\n`, 'mind/shared/knowledge/k-a.md': 'x' })
    expect(await folderMindVersion(detached)).toBe(sha)
    const onBranch = await folder({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/refs/heads/main': `${'b'.repeat(40)}\n`,
    })
    expect(await folderMindVersion(onBranch)).toBe('b'.repeat(40))
  })

  it('FR-TRAIN-8: the indexed version is the newest mind.indexed event, null before the first build', async () => {
    expect(await indexedMindVersion(db)).toBeNull()
    await indexed('v-old', '2026-10-01T10:00:00Z')
    await indexed('v-new', '2026-10-02T10:00:00Z')
    expect(await indexedMindVersion(db)).toBe('v-new')
  })

  it('FR-TRAIN-8: an index built for another mind than the folder is a problem said in plain words', () => {
    expect(mindStateProblem({ folder: 'abc', indexed: 'abc' })).toBeNull()
    // An index never built is the empty mind.
    expect(mindStateProblem({ folder: 'empty', indexed: null })).toBeNull()
    const problem = mindStateProblem({ folder: 'abc', indexed: 'xyz' })
    expect(problem).toMatch(/xyz/)
    expect(problem).toMatch(/abc/)
    expect(problem).toMatch(/не обновляет/)
    expect(mindStateProblem({ folder: 'abc', indexed: null })).toMatch(/abc/)
  })

  it('FR-TRAIN-8: reading the state writes nothing: no index rows, no event', async () => {
    const dir = await folder({ 'mind/shared/knowledge/k-a.md': 'один' })
    const state = await readMindState(db, dir)
    expect(state.indexed).toBeNull()
    expect(state.folder).toMatch(/^[0-9a-f]{12}$/)
    expect((await db.select({ n: count() }).from(mindIndex))[0]?.n).toBe(0)
    expect((await db.select({ n: count() }).from(event))[0]?.n).toBe(0)
  })
})
