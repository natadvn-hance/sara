import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SorterOutput } from '@sara/shared'
import { describe, expect, it } from 'vitest'

const ROLE = resolve(import.meta.dirname, '../../../roles/sorter')
const role = () => readFile(join(ROLE, 'role.md'), 'utf8')

describe('the Sorter role judges by the board snippet, like old Sara', () => {
  it('FR-LEAD-2: the role names what to skip: one platform, narrow Direct, one-off technical work, staff vacancies, percent-only, non-marketing', async () => {
    const text = await role()
    for (const mark of [
      'Wildberries',
      'Директ',
      'парсинг',
      'вакансия в штат',
      'только за процент',
      'не про маркетинг',
    ])
      expect(text).toContain(mark)
  })

  it('FR-LEAD-2: the role passes strategy, diagnostics, positioning and business support, and passes when in doubt', async () => {
    const text = await role()
    for (const mark of ['стратегию', 'диагностику', 'позиционирование', 'сопровождение бизнеса'])
      expect(text).toContain(mark)
    expect(text).toMatch(/При сомнении никогда не отсеивай/)
  })

  it('FR-LEAD-2: the answer keeps the contract fields and the role has no long dash', async () => {
    const text = await role()
    for (const field of Object.keys(SorterOutput.shape)) expect(text).toContain(field)
    expect(text).not.toContain(String.fromCharCode(0x2014))
    expect(text).not.toContain(String.fromCharCode(0x2013))
  })

  it('FR-LEAD-2: the role version is raised, so a run is traceable to the triage', async () => {
    const meta = JSON.parse(await readFile(join(ROLE, 'meta.json'), 'utf8')) as { version: number }
    expect(meta.version).toBeGreaterThanOrEqual(1)
  })

  it('FR-LEAD-2: every eval sample has its order and an expected verdict the contract knows', async () => {
    const samples = JSON.parse(await readFile(join(ROLE, 'evals/samples.json'), 'utf8')) as {
      order: string
      expected: string
    }[]
    expect(samples.length).toBeGreaterThanOrEqual(18)
    for (const s of samples) {
      expect(['fit', 'maybe', 'reject']).toContain(s.expected)
      await readFile(resolve(ROLE, '../../tests/fixtures/orders', s.order), 'utf8')
    }
    expect(samples.find((s) => s.order === '90000005.json')?.expected).toBe('reject')
  })
})
