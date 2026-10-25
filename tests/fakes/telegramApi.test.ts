import { describe, expect, it } from 'vitest'
import { createFakeTelegram, htmlProblem } from './telegramApi'

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

describe('the fake Telegram send delay', () => {
  it('NFR-REL-3: a held answer leaves the message recorded at once, as a slow Telegram does', async () => {
    const tg = await createFakeTelegram()
    try {
      tg.setSendDelay(300)
      const started = Date.now()
      const answer = fetch(`${tg.apiRoot}/bot${tg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: 1, text: 'привет' }),
      })
      // The bot has the message; the caller does not know yet.
      await new Promise((r) => setTimeout(r, 100))
      expect(tg.sent.map((m) => m.text)).toEqual(['привет'])
      expect(Date.now() - started).toBeLessThan(300)
      expect((await answer).ok).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(290)
    } finally {
      await tg.close()
    }
  })
})
