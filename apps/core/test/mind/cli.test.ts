import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mindIndex } from '../../src/db/schema'
import { acceptProposals, main } from '../../src/mind/cli'
import { loadMind } from '../../src/mind/loader'
import { proposeMind } from '../../src/mind/proposals'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'
import { git, gitCommitAll, putFile, putRecord, tempMind } from '../helpers/mind'

const FROM = 'mind/proposals/shared/knowledge/k-price.md'
const TO = 'mind/shared/knowledge/k-price.md'

async function proposalMind(): Promise<string> {
  const root = await tempMind()
  await putRecord(
    root,
    'mind/shared/knowledge/k-about.md',
    { id: 'k-about', type: 'knowledge' },
    'О Hance.',
  )
  await putRecord(
    root,
    FROM,
    { id: 'k-price', type: 'knowledge', status: 'proposal', sources: ['interview:1'] },
    '## Факт\nЦену называет Борис.',
  )
  return root
}

const gone = (p: string) =>
  stat(p).then(
    () => false,
    () => true,
  )

describe('mind accept', () => {
  it('FR-MIND-3: accept moves a proposal into the mind and confirms it', async () => {
    const root = await proposalMind()
    await gitCommitAll(root)
    const untracked = 'mind/proposals/shared/knowledge/k-terms.md'
    await putRecord(
      root,
      untracked,
      { id: 'k-terms', type: 'knowledge', status: 'proposal' },
      'Сроки.',
    )
    await putFile(root, 'notes.txt', 'чужое изменение\n')
    await git(root, 'add', 'notes.txt')

    const done = await acceptProposals(root, [FROM, 'shared/knowledge/k-terms.md'])
    expect(done).toEqual([
      { id: 'k-price', from: FROM, to: TO, committed: true },
      { id: 'k-terms', from: untracked, to: 'mind/shared/knowledge/k-terms.md', committed: true },
    ])
    expect(await gone(join(root, FROM))).toBe(true)
    const text = await readFile(join(root, TO), 'utf8')
    expect(text).toMatch(/^status: confirmed$/m)
    expect(text).toMatch(/sources:\n {2}- interview:1/)
    expect(text).toMatch(/## Факт\nЦену называет Борис\./)

    expect(await git(root, 'log', '--format=%s', '-2')).toBe(
      'mind: accept k-terms (Boris said yes)\nmind: accept k-price (Boris said yes)',
    )
    expect(await git(root, 'show', '--no-renames', '--name-status', '--format=', 'HEAD~1')).toBe(
      `D\t${FROM}\nA\t${TO}`,
    )
    expect(await git(root, 'status', '--porcelain')).toBe('A  notes.txt')
    const m = await loadMind(root)
    expect(m.records.map((r) => [r.front.id, r.front.status])).toEqual([
      ['k-about', 'confirmed'],
      ['k-price', 'confirmed'],
      ['k-terms', 'confirmed'],
    ])
  })

  it('FR-MIND-3: accept in a folder without git moves the file and commits nothing', async () => {
    const root = await proposalMind()
    expect(await acceptProposals(root, [join(root, FROM)])).toEqual([
      { id: 'k-price', from: FROM, to: TO, committed: false },
    ])
    expect(await readFile(join(root, TO), 'utf8')).toMatch(/^status: confirmed$/m)
    expect(await gone(join(root, FROM))).toBe(true)
  })

  it('FR-MIND-3: accept refuses a file outside proposals or one the mind would not load', async () => {
    const root = await proposalMind()
    await expect(acceptProposals(root, ['mind/shared/knowledge/k-about.md'])).rejects.toThrow(
      /proposals/,
    )
    await putRecord(
      root,
      'mind/proposals/shared/knowledge/k-about-2.md',
      { id: 'k-about', type: 'knowledge', status: 'proposal' },
      'Повтор номера.',
    )
    await expect(acceptProposals(root, ['shared/knowledge/k-about-2.md'])).rejects.toThrow(
      /k-about/,
    )
    await putRecord(
      root,
      'mind/proposals/shared/knowledge/k-bad.md',
      { id: 'k-bad', type: 'knowledge', status: 'proposal', topic: 'money' },
      'Неверная тема.',
    )
    await expect(acceptProposals(root, ['shared/knowledge/k-bad.md'])).rejects.toThrow(/topic/)
    expect(await gone(join(root, 'mind/shared/knowledge/k-bad.md'))).toBe(true)
    expect(await gone(join(root, 'mind/shared/knowledge/k-about-2.md'))).toBe(true)
  })

  it('FR-MIND-3: accept refuses paths that leave proposals: ../x, an absolute path outside, proposals/../shared', async () => {
    const root = await proposalMind()
    const outside = await tempMind()
    await putRecord(
      outside,
      'mind/proposals/shared/knowledge/k-out.md',
      { id: 'k-out', type: 'knowledge', status: 'proposal' },
      'Чужая папка.',
    )
    for (const p of [
      '../x',
      '../mind/proposals/shared/knowledge/k-price.md',
      join(outside, 'mind/proposals/shared/knowledge/k-out.md'),
      '/etc/hosts',
      'mind/proposals/../shared/knowledge/k-about.md',
      'mind/proposals/../../x',
    ]) {
      await expect(acceptProposals(root, [p]), p).rejects.toThrow(/proposals/)
    }
    expect(await gone(join(root, TO))).toBe(true)
    expect(await gone(join(root, FROM))).toBe(false)
  })

  it('FR-MIND-3: accept refuses a target that holds another record, and replaces the one with the same id', async () => {
    const root = await proposalMind()
    await putRecord(
      root,
      TO,
      { id: 'k-other', type: 'knowledge' },
      'Другая запись на том же месте.',
    )
    await expect(acceptProposals(root, [FROM])).rejects.toThrow(/k-other/)
    expect(await gone(join(root, FROM))).toBe(false)
    expect(await readFile(join(root, TO), 'utf8')).toMatch(/Другая запись/)

    await putRecord(root, TO, { id: 'k-price', type: 'knowledge', version: 1 }, 'Старая цена.')
    await putRecord(
      root,
      FROM,
      { id: 'k-price', type: 'knowledge', version: 2, status: 'proposal' },
      'Новая цена.',
    )
    expect(await acceptProposals(root, [FROM])).toEqual([
      { id: 'k-price', from: FROM, to: TO, committed: false },
    ])
    expect(await readFile(join(root, TO), 'utf8')).toMatch(/Новая цена\./)
  })

  it('FR-MIND-3: accept stops when the rewrite does not leave the record confirmed', async () => {
    const root = await tempMind()
    const flow =
      '---\n{id: k-flow, type: knowledge, scope: shared, status: proposal, version: 1, sources: [boris], valid_from: 2026-01-01, valid_to: null}\n---\nФакт.\n'
    await putFile(root, 'mind/proposals/shared/knowledge/k-flow.md', flow)
    await expect(acceptProposals(root, ['shared/knowledge/k-flow.md'])).rejects.toThrow(/confirmed/)
    expect(await gone(join(root, 'mind/shared/knowledge/k-flow.md'))).toBe(true)
    expect(await gone(join(root, 'mind/proposals/shared/knowledge/k-flow.md'))).toBe(false)
  })
})

describe('mind command line', () => {
  const { db, close } = openTestDb()
  afterAll(close)
  beforeEach(() => resetDb(db))

  const io = () => ({ log: vi.fn<(s: string) => void>(), error: vi.fn<(s: string) => void>() })

  it('FR-MIND-3: mind accept needs --mind and never falls back to the mind folder of the config', async () => {
    const root = await proposalMind()
    const out = io()
    const env = { SARA_MIND_DIR: root }
    expect(await main(['accept', FROM], env, out)).toBe(1)
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('--mind'))
    expect(out.log).not.toHaveBeenCalled()
    expect(await gone(join(root, FROM))).toBe(false)
    expect(await gone(join(root, TO))).toBe(true)

    expect(await main(['accept', FROM, '--mind', root], env, out)).toBe(0)
    expect(out.log).toHaveBeenCalledWith(expect.stringContaining('k-price'))
    expect(await gone(join(root, FROM))).toBe(true)
  })

  it('FR-MIND-3: mind accept is refused when NODE_ENV is production', async () => {
    const root = await proposalMind()
    const out = io()
    expect(await main(['accept', FROM, '--mind', root], { NODE_ENV: 'production' }, out)).toBe(1)
    expect(out.error).toHaveBeenCalledWith(expect.stringContaining('production'))
    expect(await gone(join(root, FROM))).toBe(false)
    expect(await gone(join(root, TO))).toBe(true)
  })

  it('FR-MIND-3: mind accept takes --mind relative to where the developer typed the command', async () => {
    const root = await proposalMind()
    const out = io()
    const env = { INIT_CWD: join(root, '..') }
    const name = root.slice(root.lastIndexOf('/') + 1)
    expect(await main(['accept', FROM, '--mind', name], env, out)).toBe(0)
    expect(await gone(join(root, TO))).toBe(false)
  })

  it('FR-MIND-3: errors of the commands go to stderr and the exit code is 1', async () => {
    const out = io()
    expect(await main([], {}, out)).toBe(1)
    expect(await main(['accept'], {}, out)).toBe(1)
    expect(await main(['proposals'], {}, out)).toBe(1)
    expect(await main(['nope'], {}, out)).toBe(1)
    expect(out.error).toHaveBeenCalledTimes(4)
    expect(out.log).not.toHaveBeenCalled()
  })

  it('FR-MIND-3: mind proposals exports into a clone and exits 1 when a file was already there', async () => {
    const clone = await tempMind()
    await git(clone, 'init', '-q')
    const path = 'mind/proposals/shared/knowledge/k-interview-1.md'
    await proposeMind(db, { path, content: 'знание\n', kind: 'knowledge', source: 'interview:1' })
    const env = { DATABASE_URL: testDatabaseUrl() }
    const out = io()
    expect(await main(['proposals', '--to', clone], env, out)).toBe(0)
    expect(out.log).toHaveBeenCalledWith(expect.stringContaining('Выложено предложений: 1'))
    expect(await readFile(join(clone, path), 'utf8')).toBe('знание\n')

    await resetDb(db)
    await proposeMind(db, { path, content: 'другое\n', kind: 'knowledge', source: 'interview:2' })
    const again = io()
    expect(await main(['proposals', '--to', clone], env, again)).toBe(1)
    expect(again.error).toHaveBeenCalledWith(expect.stringContaining(path))
    expect(await readFile(join(clone, path), 'utf8')).toBe('знание\n')

    const notClone = io()
    expect(await main(['proposals', '--to', await tempMind()], env, notClone)).toBe(1)
    expect(notClone.error).toHaveBeenCalledWith(expect.stringContaining('.git'))
  })

  it('FR-MIND-2: mind index builds the index and exits 1 when a record failed to load', async () => {
    const root = await tempMind()
    await putRecord(root, TO, { id: 'k-price', type: 'knowledge' }, 'Цена по запросу.')
    const env = { DATABASE_URL: testDatabaseUrl(), SARA_MIND_DIR: root }
    const ok = io()
    expect(await main(['index'], env, ok)).toBe(0)
    expect(ok.log).toHaveBeenCalledWith(expect.stringContaining('записей в индексе 1'))
    expect(ok.error).not.toHaveBeenCalled()

    await putRecord(
      root,
      'mind/shared/knowledge/k-bad.md',
      { id: 'k-bad', type: 'knowledge', status: 'maybe' },
      'Неверный статус.',
    )
    const bad = io()
    expect(await main(['index'], env, bad)).toBe(1)
    expect(bad.error).toHaveBeenCalledWith(
      expect.stringContaining('mind/shared/knowledge/k-bad.md'),
    )
    expect(bad.log).toHaveBeenCalledWith(expect.stringContaining('записей в индексе 1'))
    expect((await db.select().from(mindIndex)).map((r) => r.recordId)).toEqual(['k-price'])
  })
})
