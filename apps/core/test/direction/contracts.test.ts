import { DirectionCase, DirectionProfileData, ReplyFormat } from '@sara/shared'
import { describe, expect, it } from 'vitest'

const goodCase = {
  id: 'clinic_site',
  title: 'Сайт клиники',
  url: 'https://hance.example/cases/clinic',
  summary: 'Запись онлайн, плюс 40% обращений',
  tags: ['сайт', 'медицина'],
  show_when: 'Клиенту нужен сайт услуг с записью',
  never_when: null,
}
const goodFormat = {
  parts: [{ id: 'understanding', title: 'Понимание ситуации', hint: 'Что видно из заказа' }],
  max_chars: 500,
  tone: ['спокойно, без клише'],
  examples: [],
  max_cases: 2,
}

describe('direction profile contracts', () => {
  it('FR-ACC-2: a case needs an https link and a unique id', () => {
    expect(DirectionCase.safeParse(goodCase).success).toBe(true)
    expect(DirectionCase.safeParse({ ...goodCase, url: 'http://hance.example/x' }).success).toBe(
      false,
    )
    expect(DirectionCase.safeParse({ ...goodCase, url: 'javascript:alert(1)' }).success).toBe(false)
    expect(DirectionCase.safeParse({ ...goodCase, id: 'Bad Id' }).success).toBe(false)
    const profile = (cases: unknown[]) =>
      DirectionProfileData.safeParse({ speed: 'normal', reply_format: null, cases })
    expect(profile([goodCase, goodCase]).success).toBe(false)
    expect(profile([goodCase]).success).toBe(true)
    const many = Array.from({ length: 31 }, (_, i) => ({ ...goodCase, id: `case_${i}` }))
    expect(profile(many).success).toBe(false)
  })

  it('FR-ACC-2: the reply format keeps 500 characters at most and 3 cases at most', () => {
    expect(ReplyFormat.safeParse(goodFormat).success).toBe(true)
    expect(ReplyFormat.safeParse({ ...goodFormat, max_chars: 501 }).success).toBe(false)
    expect(ReplyFormat.safeParse({ ...goodFormat, max_chars: 0 }).success).toBe(false)
    expect(ReplyFormat.safeParse({ ...goodFormat, max_cases: 4 }).success).toBe(false)
    expect(ReplyFormat.safeParse({ ...goodFormat, examples: ['a', 'b', 'c', 'd'] }).success).toBe(
      false,
    )
  })
})
