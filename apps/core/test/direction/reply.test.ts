import type { DirectionCase, ReplyFormat } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { analystProfileText, caseReserve, placeCases } from '../../src/direction/reply'

const aCase = (id: string, over: Partial<DirectionCase> = {}): DirectionCase => ({
  id,
  title: `Проект ${id}`,
  url: `https://hance.example/cases/${id}`,
  summary: `Суть ${id}`,
  tags: ['сайт'],
  show_when: `Когда нужен ${id}`,
  never_when: null,
  ...over,
})
const FORMAT: ReplyFormat = {
  parts: [
    { id: 'understanding', title: 'Понимание', hint: 'Про ситуацию клиента' },
    { id: 'question', title: 'Вопрос', hint: 'Один короткий вопрос' },
  ],
  max_chars: 500,
  tone: ['спокойно'],
  examples: ['Понимаю, о чём речь. Что для вас главное?'],
  max_cases: 2,
}
const profile = (over: object = {}) => ({
  reply_format: FORMAT,
  cases: [aCase('a'), aCase('b'), aCase('c')],
  ...over,
})

describe('what the Analyst is told of a direction', () => {
  it('FR-LEAD-6: without a format or cases there is nothing to add, so the input stays as it is', () => {
    expect(analystProfileText({ reply_format: null, cases: [] })).toBe('')
  })

  it('FR-LEAD-6: the format and the case rules go in, the links never do', () => {
    const text = analystProfileText(
      profile({ cases: [aCase('a', { never_when: 'бюджет до 10 000' })] }),
    )
    expect(text).toContain('Формат отклика этого направления')
    expect(text).toContain('1. Понимание: Про ситуацию клиента')
    expect(text).toContain('спокойно')
    expect(text).toContain('Понимаю, о чём речь. Что для вас главное?')
    expect(text).toContain('a: Проект a')
    expect(text).toContain('Показывай, когда: Когда нужен a')
    expect(text).toContain('Не показывай, когда: бюджет до 10 000')
    expect(text).toContain('не больше 2')
    expect(text).not.toContain('https://')
    expect(text).not.toContain('hance.example')
  })

  it('FR-LEAD-6: cases are not offered when the format allows none or the library is empty', () => {
    expect(
      analystProfileText(profile({ reply_format: { ...FORMAT, max_cases: 0 } })),
    ).not.toContain('Кейсы')
    expect(analystProfileText(profile({ cases: [] }))).not.toContain('Кейсы')
    expect(analystProfileText({ reply_format: null, cases: [aCase('a')] })).not.toContain('Кейсы')
  })
})

describe('room for cases', () => {
  it('FR-LEAD-6: the room taken from the text is the blank line and the longest cases that may go in', () => {
    const p = profile({ cases: [aCase('a'), aCase('bbbbbbbb'), aCase('cc')] })
    const line = (c: DirectionCase) => `Похожая работа: ${c.title}, ${c.url}`.length
    const [x, y] = [aCase('bbbbbbbb'), aCase('cc')]
    // The two longest of three, one per line, after the blank line.
    expect(caseReserve(p)).toBe(2 + line(x) + 1 + line(y))
  })

  it('FR-LEAD-6: no room is taken without cases, without a format or when none may go in', () => {
    expect(caseReserve({ reply_format: null, cases: [aCase('a')] })).toBe(0)
    expect(caseReserve(profile({ cases: [] }))).toBe(0)
    expect(caseReserve(profile({ reply_format: { ...FORMAT, max_cases: 0 } }))).toBe(0)
  })
})

describe('placing cases into a bid', () => {
  const text = 'Добрый день!\n\nПонимаю ситуацию. Что для вас главное?'

  it('FR-LEAD-6: the link and the title come from the library, after a blank line, the text untouched', () => {
    const r = placeCases(text, profile(), ['a'])
    expect(r.shown).toEqual(['a'])
    expect(r.text).toBe(`${text}\n\nПохожая работа: Проект a, https://hance.example/cases/a`)
  })

  it('FR-LEAD-6: unknown and repeated ids are dropped, and not more than the format allows', () => {
    const r = placeCases(text, profile(), ['nope', 'b', 'b', 'a', 'c'])
    expect(r.shown).toEqual(['b', 'a'])
    expect(r.text.match(/Похожая работа/g)).toHaveLength(2)
  })

  it('FR-LEAD-6: a case that does not fit 500 characters is not added and the text is not cut', () => {
    const long = `${'а'.repeat(498)}.`
    expect(long.length).toBe(499)
    const r = placeCases(long, profile(), ['a'])
    expect(r).toEqual({ text: long, shown: [] })
  })

  it('FR-LEAD-6: when only the first of two cases fits, the last one is dropped', () => {
    const line = (c: string) => `Похожая работа: Проект ${c}, https://hance.example/cases/${c}`
    const room = 500 - (2 + line('a').length)
    const body = 'б'.repeat(room)
    const r = placeCases(body, profile(), ['a', 'b'])
    expect(r.shown).toEqual(['a'])
    expect(r.text.length).toBeLessThanOrEqual(500)
    expect(r.text.startsWith(body)).toBe(true)
  })

  it('FR-LEAD-6: a link that is not https is never placed', () => {
    const bad = { ...aCase('a'), url: 'http://hance.example/a' } as DirectionCase
    expect(placeCases(text, profile({ cases: [bad] }), ['a'])).toEqual({ text, shown: [] })
    const js = { ...aCase('a'), url: 'javascript:alert(1)' } as DirectionCase
    expect(placeCases(text, profile({ cases: [js] }), ['a']).shown).toEqual([])
  })

  it('FR-LEAD-6: nothing is placed without a format, with zero cases allowed or without ids', () => {
    expect(placeCases(text, { reply_format: null, cases: [aCase('a')] }, ['a']).shown).toEqual([])
    expect(
      placeCases(text, profile({ reply_format: { ...FORMAT, max_cases: 0 } }), ['a']).shown,
    ).toEqual([])
    expect(placeCases(text, profile(), [])).toEqual({ text, shown: [] })
  })

  it("FR-LEAD-6: the format's own max_chars is the ceiling, below 500", () => {
    const r = placeCases(text, profile({ reply_format: { ...FORMAT, max_chars: 100 } }), ['a'])
    expect(r.text.length).toBeLessThanOrEqual(100)
    expect(r.shown).toEqual([])
  })
})
