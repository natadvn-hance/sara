import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROLE = resolve(import.meta.dirname, '../../../roles/analyst')

describe('the Analyst role reads the client line of the order page', () => {
  it('FR-LEAD-6: the role says what «Клиент на площадке» is, where to use it and that it stays out of the text', async () => {
    const text = await readFile(join(ROLE, 'role.md'), 'utf8')
    expect(text).toContain('Клиент на площадке')
    expect(text).toMatch(/risks/)
    expect(text).toMatch(/condition/)
    expect(text).toMatch(/Не пиши в text[^\n]*(отзыв|клиент на площадке)/i)
  })

  it('FR-LEAD-6: the role version is raised, so a model call is traceable to this input', async () => {
    const meta = JSON.parse(await readFile(join(ROLE, 'meta.json'), 'utf8')) as { version: number }
    expect(meta.version).toBeGreaterThanOrEqual(2)
  })
})

describe('the Analyst role writes the text of a bid in the voice of Boris (26.10)', () => {
  const role = () => readFile(join(ROLE, 'role.md'), 'utf8')

  it('NFR-UX-1: no dashes and no hyphen in a common word, with the words Boris gave as examples', async () => {
    const text = await role()
    expect(text).toMatch(/без тире/i)
    expect(text).toContain('что то')
    expect(text).toContain('все таки')
    expect(text).toMatch(/дефис[^\n]*(имен|названи|бренд)/i)
    // The hyphen of a word in two alphabets goes as well (Boris writes «B2B компании»).
    expect(text).toContain('B2B компании')
  })

  it('NFR-UX-1: no period at the end of a paragraph, the question and exclamation marks stay', async () => {
    const text = await role()
    expect(text).toMatch(/в конце абзаца[^\n]*точк/i)
    expect(text).toMatch(/«\?»[^\n]*«!»|«!»[^\n]*«\?»/)
  })

  it('NFR-UX-1: no emoji in the text', async () => {
    expect(await role()).toMatch(/без эмодзи/i)
  })

  it("FR-LEAD-6: the greeting is the code's, by the time of day at the moment of sending, and the model never writes it", async () => {
    const text = await role()
    expect(text).toMatch(/Не начинай с приветствия/)
    expect(text).toMatch(/приветствие поставит программа/)
    expect(text).toMatch(/время суток|времени суток|по времени/i)
  })

  it('NFR-UX-1: the role itself holds no long dash', async () => {
    expect(await role()).not.toMatch(
      new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`),
    )
  })

  it('FR-LEAD-6: the role version is 4 or more after the voice rules', async () => {
    const meta = JSON.parse(await readFile(join(ROLE, 'meta.json'), 'utf8')) as { version: number }
    expect(meta.version).toBeGreaterThanOrEqual(4)
  })

  it('FR-LEAD-6: the bid opens with a human phrase after the greeting, from the openers Boris gave on 27.10', async () => {
    const text = await role()
    for (const opener of [
      'понимаю, о чём вы',
      'Если я правильно понял, то',
      'Спасибо за понятное описание',
      'Вы очень точно подметили',
    ])
      expect(text).toContain(opener)
    expect(text).toContain('каждый раз разное')
    const meta = JSON.parse(await readFile(join(ROLE, 'meta.json'), 'utf8')) as { version: number }
    expect(meta.version).toBeGreaterThanOrEqual(5)
  })
})
