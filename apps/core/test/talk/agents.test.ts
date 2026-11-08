import { describe, expect, it } from 'vitest'
import { AGENTS, switchTo } from '../../src/talk/agents'
import { createLoraLink } from '../../src/talk/lora'

describe('the voice app: Lora and Sara', () => {
  it('FR-NOTIF-5: «позови Сару» calls Sara, «позови Лору» calls Lora, and the bare name does too', () => {
    for (const t of [
      'Позови Сару',
      'позови сару.',
      'Переключи на Сару',
      'дай Сару',
      'Сара',
      'Сара, ты тут?',
      'давай Сару',
      'соедини с Сарой',
    ])
      expect(switchTo(t, 'lora'), t).toEqual({ agent: 'sara', rest: '' })
    for (const t of ['Позови Лору', 'верни Лору', 'Лора!', 'переключись на Лору'])
      expect(switchTo(t, 'sara'), t).toEqual({ agent: 'lora', rest: '' })
  })

  it('FR-NOTIF-5: a call with a question passes the question on to the one called', () => {
    expect(switchTo('Позови Сару, что по лидам сегодня?', 'lora')).toEqual({
      agent: 'sara',
      rest: 'что по лидам сегодня?',
    })
  })

  it('FR-NOTIF-5: words about the other one, or the name of the one speaking, change nothing', () => {
    for (const t of [
      'что Сара делала с заявками вчера',
      'напомни Саре про кофейню',
      'позвони клиенту',
      'Сара сказала, что баланс пустой',
    ])
      expect(switchTo(t, 'lora'), t).toBeNull()
    expect(switchTo('Сара, что в очереди?', 'sara')).toBeNull()
    expect(switchTo('позови Лору', 'lora')).toBeNull()
  })

  it('FR-NOTIF-5: each one has her own voice and greeting', () => {
    expect(AGENTS.lora).toMatchObject({ name: 'Лора', speaker: 'baya' })
    expect(AGENTS.sara).toMatchObject({ name: 'Сара', speaker: 'xenia' })
    expect(AGENTS.lora.greeting).toBe('Борь, я на связи.')
    expect(AGENTS.sara.greeting).toBe('Да-да, Борь, я тут.')
  })
})

describe('the voice app: the link to Lora', () => {
  it("FR-NOTIF-5: Boris's words wait for Lora's channel, which takes them by a long wait", async () => {
    let now = 1_000_000
    const link = createLoraLink({ now: () => now })
    expect(link.connected()).toBe(false)
    const waiting = link.next(1000)
    expect(link.connected()).toBe(true)
    link.push({
      talk: 't1',
      text: 'что у меня завтра',
      voice: true,
      at: '2026-11-07T15:00:00.000Z',
    })
    expect(await waiting).toEqual({
      talk: 't1',
      text: 'что у меня завтра',
      voice: true,
      at: '2026-11-07T15:00:00.000Z',
    })
    expect(await link.next(20)).toBeNull()
    link.reply('t1', 'Завтра в десять созвон с Максом')
    expect(link.history().map((l) => [l.author, l.text])).toEqual([
      ['boris', 'что у меня завтра'],
      ['lora', 'Завтра в десять созвон с Максом'],
    ])
    // A channel that has not asked for a minute and a half is not on the line.
    now += 91_000
    expect(link.connected()).toBe(false)
  })
})

describe('the voice app: a word for Lora is never lost', () => {
  it('FR-NOTIF-5: a wait whose request has gone is dropped, and the word stays for the next ask', async () => {
    const link = createLoraLink()
    const gone = new AbortController()
    const dropped = link.next(5000, gone.signal)
    gone.abort()
    expect(await dropped).toBeNull()
    link.push({ talk: 't9', text: 'проверка связи', voice: true, at: '2026-11-08T11:20:00.000Z' })
    expect(await link.next(100)).toMatchObject({ talk: 't9', text: 'проверка связи' })
  })

  it('FR-NOTIF-5: a request that closes while it is woken does not take the word', async () => {
    const link = createLoraLink()
    const gone = new AbortController()
    const waiting = link.next(5000, gone.signal)
    // The word comes and the request closes in the same moment, before the waiter runs.
    link.push({ talk: 't10', text: 'ещё раз', voice: false, at: '2026-11-08T11:21:00.000Z' })
    gone.abort()
    expect(await waiting).toBeNull()
    expect(await link.next(100)).toMatchObject({ talk: 't10' })
  })
})
