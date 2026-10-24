import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type AnalystOutput, ProfiOrder } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import type { Gateway, RoleCallResult } from '../src/gateway/gateway'
import { draftOf, editOf, greetingOf, priceWithin, writeDraft } from '../src/leads/draft'

const ROOT = resolve(import.meta.dirname, '../../..')
const DASH = String.fromCharCode(0x2014)
const order = async () =>
  ProfiOrder.parse(
    JSON.parse(await readFile(join(ROOT, 'tests/fixtures/orders/90000001.json'), 'utf8')),
  )

/** A gateway that answers the given results in turn and keeps every input it was sent. */
function stubGateway(results: (AnalystOutput | null)[]) {
  const inputs: string[] = []
  const gw: Gateway = {
    async call<T>(_role: string, input: string): Promise<RoleCallResult<T>> {
      inputs.push(input)
      const out = results[inputs.length - 1] ?? null
      return out
        ? { ok: true, output: out as T, durationMs: 1, modelCallId: 'm' }
        : { ok: false, errorClass: 'timeout', message: 'no', durationMs: 1, modelCallId: 'm' }
    },
  }
  return { gw, inputs }
}
const answer = (text: string, price: number | null = 90000): AnalystOutput => ({
  hidden_need: 'Боится долгого запуска',
  text,
  price_rub: price,
})
const BODY = 'Понимаю, клинике важно быстро начать запись.\n\nКогда хотите открыть запись онлайн?'

describe('bid text rules', () => {
  it('FR-LEAD-6: the greeting is «Имя, добрый день!» with a known name, else «Добрый день!»', () => {
    expect(greetingOf('Ирина')).toBe('Ирина, добрый день!')
    expect(greetingOf('  Анна Петрова ')).toBe('Анна, добрый день!')
    expect(greetingOf('')).toBe('Добрый день!')
    expect(greetingOf('Клиент 3')).toBe('Добрый день!')
    expect(greetingOf('Заказчик')).toBe('Добрый день!')
  })

  it("FR-LEAD-6: a greeting the model wrote is replaced by the code's", () => {
    expect(draftOf('Добрый день! Понимаю задачу.\n\nКогда запуск?', 'Ирина')).toBe(
      'Ирина, добрый день!\n\nПонимаю задачу.\n\nКогда запуск?',
    )
  })

  it("FR-LEAD-6: Boris's own greeting stays, a text without one gets it", () => {
    expect(editOf('Здравствуйте, Ирина! Текст', 'Ирина')).toBe('Здравствуйте, Ирина! Текст')
    expect(editOf('Текст', 'Ирина')).toBe('Ирина, добрый день!\n\nТекст')
  })

  it('FR-LEAD-6: a name with brackets or other signs never breaks the greeting', () => {
    expect(greetingOf('Анна(Юля)')).toBe('Анна, добрый день!')
    expect(editOf('Текст', 'Анна(Юля)')).toBe('Анна, добрый день!\n\nТекст')
    expect(editOf('Анна, текст', 'Анна*')).toBe('Анна, добрый день!\n\nТекст')
  })

  it('FR-LEAD-6: a word that only begins like a greeting is not one', () => {
    expect(draftOf('Приветливый персонал решает половину задачи.\n\nКогда запуск?', 'Ирина')).toBe(
      'Ирина, добрый день!\n\nПриветливый персонал решает половину задачи.\n\nКогда запуск?',
    )
    expect(editOf('Приветливый сайт сделаем за две недели. Когда старт?', 'Ирина')).toBe(
      'Ирина, добрый день!\n\nПриветливый сайт сделаем за две недели. Когда старт?',
    )
    expect(editOf('Приветствие на сайте поменяем. Когда старт?', '')).toBe(
      'Добрый день!\n\nПриветствие на сайте поменяем. Когда старт?',
    )
    expect(editOf('Здравствуйте! Текст', 'Ирина')).toBe('Здравствуйте! Текст')
    expect(editOf('Привет, Ирина! Текст', 'Ирина')).toBe('Привет, Ирина! Текст')
  })

  it('NFR-UX-1: long and short dashes in a draft become a hyphen', () => {
    expect(draftOf(`Сайт ${DASH} это просто`, '')).toBe('Добрый день!\n\nСайт - это просто')
    expect(editOf('Сайт – это просто', '')).toBe('Добрый день!\n\nСайт - это просто')
  })

  it('FR-LEAD-6: the price stays within the client budget', () => {
    expect(priceWithin(90000, 'до 150 000 ₽')).toBe(90000)
    expect(priceWithin(200000, 'до 150 000 ₽')).toBeNull()
    expect(priceWithin(15000, '1 ₽')).toBeNull()
    expect(priceWithin(0, null)).toBeNull()
    expect(priceWithin(5000, null)).toBe(5000)
    expect(priceWithin(30000, 'от 10 000 до 50 000 ₽')).toBe(30000)
  })
})

describe('the Analyst', () => {
  it('FR-LEAD-6: the Analyst never sees the client name and is told the length left', async () => {
    const { gw, inputs } = stubGateway([answer(BODY)])
    const d = await writeDraft(gw, await order())
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).not.toContain('Ирина')
    expect(inputs[0]).toContain('Нужен сайт для клиники')
    expect(inputs[0]).toContain('Длина текста: не больше 479 знаков')
    expect(d).toEqual({ text: `Ирина, добрый день!\n\n${BODY}`, priceRub: 90000, attempts: 1 })
  })

  it('FR-LEAD-6: a draft too long with the greeting is asked once more', async () => {
    const { gw, inputs } = stubGateway([answer('а'.repeat(600)), answer('Коротко. Когда запуск?')])
    const d = await writeDraft(gw, await order())
    expect(d.attempts).toBe(2)
    expect(d.text).toBe('Ирина, добрый день!\n\nКоротко. Когда запуск?')
    expect(inputs[1]).toContain('Прошлый вариант вышел 621')
  })

  it('FR-LEAD-6: still too long after the second ask gives no draft', async () => {
    const { gw } = stubGateway([answer('а'.repeat(600)), answer('б'.repeat(600))])
    expect(await writeDraft(gw, await order())).toEqual({
      text: null,
      reason: 'too_long',
      attempts: 2,
    })
  })

  it('FR-LEAD-6: a draft that looks like JSON is never used', async () => {
    const { gw, inputs } = stubGateway([
      answer('{"text": "Понимаю"}'),
      answer('</parameter><parameter name="text">Понимаю'),
    ])
    expect(await writeDraft(gw, await order())).toEqual({
      text: null,
      reason: 'not_plain',
      attempts: 2,
    })
    expect(inputs[1]).toContain('не простой текст')
  })

  it('FR-LEAD-6: a failed Analyst call gives no draft', async () => {
    const { gw } = stubGateway([null])
    expect(await writeDraft(gw, await order())).toEqual({
      text: null,
      reason: 'no_answer',
      attempts: 1,
    })
  })

  it('FR-LEAD-6: a price above the client budget leaves the field empty', async () => {
    const { gw } = stubGateway([answer(BODY, 300000)])
    expect(await writeDraft(gw, await order())).toEqual({
      text: `Ирина, добрый день!\n\n${BODY}`,
      priceRub: null,
      attempts: 1,
    })
  })
})
