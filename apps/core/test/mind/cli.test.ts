import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acceptProposals } from '../../src/mind/cli'
import { loadMind } from '../../src/mind/loader'
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
