import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mindProposal } from '../../src/db/schema'
import { exportProposals, proposeMind } from '../../src/mind/proposals'
import { openTestDb, resetDb } from '../helpers/db'
import { tempMind } from '../helpers/mind'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const EXAMPLE = 'mind/proposals/shared/speech/examples/e-h-1.md'
const KNOWLEDGE = 'mind/proposals/shared/knowledge/k-interview-1.md'

describe('mind proposals export', () => {
  it('FR-MIND-3: exported proposals are written once and marked exported', async () => {
    await proposeMind(db, {
      path: EXAMPLE,
      content: '---\nid: e-h-1\n---\nобразец\n',
      kind: 'example',
      source: 'history:hance-marketing:1',
    })
    await proposeMind(db, {
      path: KNOWLEDGE,
      content: '---\nid: k-interview-1\n---\nзнание\n',
      kind: 'knowledge',
      source: 'interview:1',
    })
    const clone = await tempMind()
    expect(await exportProposals(db, clone)).toBe(2)
    expect(await readFile(join(clone, EXAMPLE), 'utf8')).toBe('---\nid: e-h-1\n---\nобразец\n')
    expect(await readFile(join(clone, KNOWLEDGE), 'utf8')).toBe(
      '---\nid: k-interview-1\n---\nзнание\n',
    )
    const rows = await db.select().from(mindProposal)
    expect(rows.map((r) => r.state)).toEqual(['exported', 'exported'])
    expect(rows.every((r) => r.exportedAt !== null)).toBe(true)

    await writeFile(join(clone, EXAMPLE), 'поправил разработчик\n')
    const third = 'mind/proposals/shared/speech/examples/e-h-2.md'
    await proposeMind(db, { path: third, content: 'ещё\n', kind: 'example', source: 'history:2' })
    expect(await exportProposals(db, clone)).toBe(1)
    expect(await readFile(join(clone, EXAMPLE), 'utf8')).toBe('поправил разработчик\n')
    expect(await readFile(join(clone, third), 'utf8')).toBe('ещё\n')
    expect(await exportProposals(db, clone)).toBe(0)
  })

  it('FR-MIND-3: a proposal path that leaves the clone is refused', async () => {
    await proposeMind(db, { path: '../escape.md', content: 'x', kind: 'other', source: 'test' })
    const clone = await tempMind()
    await expect(exportProposals(db, join(clone, 'inner'))).rejects.toThrow(/escape\.md/)
    await expect(stat(join(clone, 'escape.md'))).rejects.toThrow()
    expect((await db.select().from(mindProposal))[0]?.state).toBe('new')
  })
})
