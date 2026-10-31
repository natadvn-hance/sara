import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SorterOutput } from '@sara/shared'
import { describe, expect, it } from 'vitest'

const ROLE = resolve(import.meta.dirname, '../../../roles/sorter')
const role = () => readFile(join(ROLE, 'role.md'), 'utf8')

describe('the Sorter role judges by the board snippet, like old Sara', () => {
  it('FR-LEAD-2: the role names what to skip: one platform, one-off technical work, staff vacancies, non-marketing', async () => {
    const text = await role()
    for (const mark of ['Wildberries', 'парсинг', 'вакансия в штат', 'не про маркетинг'])
      expect(text).toContain(mark)
  })

  it('the screen (Boris, 30.10.2026): criteria 4-6 by core or background, with his examples and a quote', async () => {
    const text = await role()
    for (const mark of ['direct', 'wordpress', 'small_fix', 'core', 'unclear', 'quote'])
      expect(text).toContain(mark)
    for (const example of [
      '«Нужно настроить рекламу в Директе»: суть',
      '«Директ крутим, но не окупается, нужна стратегия»: фон',
      '«Поправить кнопку на сайте»: вся задача',
      '«Поправить кнопку и выстроить воронку»: часть большей задачи',
    ])
      expect(text).toContain(example)
    expect(text).toMatch(/Сомнение всегда в пользу заявки/)
  })

  it('the screen rule 6: percent-only and the other old red flags never stop an order', async () => {
    const text = await role()
    expect(text).toMatch(/Работа только за процент[^.]*не повод отсеивать/)
    const reject = text.slice(text.indexOf('Отсеивай'), text.indexOf('Работа только за процент'))
    expect(reject).not.toMatch(/процент|Директ/)
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
