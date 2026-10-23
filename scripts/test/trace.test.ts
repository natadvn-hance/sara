import { describe, expect, it } from 'vitest'
import { buildTrace } from '../trace'

const specMd = `
| FR-SET-1 | Мастер | прерванный мастер продолжается |
| FR-MIND-1 | Разум | версия |
| FR-LEAD-4 | Маршрутизатор | один отклик |
| NFR-UX-1 | Язык | без тире |
`
const backlogMd = `
### ST-M0-10 Мастер запуска, шаги 1-3
Требования: FR-SET-1, FR-SET-2.

| ST-M2-09 | Очередь | FR-LEAD-10 | критерий |
| ST-M3-01 | Маршрутизатор | FR-LEAD-4 | критерий |
`
const matrixMd = `
| FR-SET-1 | M0 | FR-MEET-1 | M6 |
| FR-MIND-1 | M0 каркас, M4 | FR-LEAD-4 | M3 |
`
// Built from parts so the trace script, which scans this file too, does not read them as real tests.
const testCall = (title: string) => ['i', 't(', "'", title, "', () => {})"].join('')

const fixture = {
  specMd,
  backlogMd,
  matrixMd,
  testFiles: [
    { path: 'apps/core/test/setup.test.ts', text: "it('FR-SET-1: wizard resumes', () => {})" },
  ],
}

describe('trace', () => {
  it('NFR-MAINT-2: maps requirement to stories and tests', () => {
    const r = buildTrace(fixture)
    expect(r.rows.find((x) => x.id === 'FR-SET-1')).toEqual({
      id: 'FR-SET-1',
      milestone: 'M0',
      stories: ['ST-M0-10'],
      tests: ['apps/core/test/setup.test.ts'],
    })
    expect(r.rows.find((x) => x.id === 'FR-LEAD-4')?.stories).toEqual(['ST-M3-01'])
  })

  it('NFR-MAINT-2: unknown id in a test is reported', () => {
    const withBadId = {
      ...fixture,
      testFiles: [...fixture.testFiles, { path: 'x.test.ts', text: testCall('FR-NOPE-1: ghost') }],
    }
    expect(buildTrace(withBadId).unknownIds).toEqual(['FR-NOPE-1'])
  })

  it('NFR-MAINT-2: M0 requirement without a test is uncovered', () => {
    const r = buildTrace(fixture)
    expect(r.uncovered).toContain('FR-MIND-1')
    expect(r.uncovered).not.toContain('FR-SET-1')
    expect(r.uncovered).not.toContain('FR-LEAD-4')
  })
})
