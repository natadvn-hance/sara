import { describe, expect, it } from 'vitest'
import { htmlProblem } from './telegramApi'

describe('the fake Telegram HTML check', () => {
  it('NFR-UX-1: takes what the Bot API takes', () => {
    expect(
      htmlProblem('<b>a</b> &amp; &lt;i&gt;\n<blockquote expandable>x</blockquote>'),
    ).toBeNull()
    expect(htmlProblem('<a href="https://x.ru/?a=1&amp;b=2">ссылка</a> &#8212;')).toBeNull()
  })

  it('NFR-UX-1: refuses what the Bot API refuses', () => {
    for (const bad of [
      'a < b',
      '<b>open',
      '</b>',
      '<b>x</i>',
      '<script>x</script>',
      'a & b',
      'a > b',
      '',
    ])
      expect(htmlProblem(bad), bad).not.toBeNull()
  })

  it('NFR-UX-1: counts the text after the tags and entities, at most 4096', () => {
    expect(htmlProblem(`<b>${'&amp;'.repeat(4096)}</b>`)).toBeNull()
    expect(htmlProblem(`<b>${'&amp;'.repeat(4097)}</b>`)).toMatch(/too long/)
    expect(htmlProblem('я'.repeat(4097))).toMatch(/too long/)
  })
})
