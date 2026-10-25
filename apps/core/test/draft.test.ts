import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AnalystOutput, ProfiOrder } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { roleJsonSchema } from '../src/gateway/claudeCli'
import type { CallOptions, Gateway, RoleCallResult } from '../src/gateway/gateway'
import {
  analystInput,
  draftOf,
  editOf,
  greetingOf,
  priceOf,
  priceWithin,
  writeDraft,
} from '../src/leads/draft'

const ROOT = resolve(import.meta.dirname, '../../..')
const DASH = String.fromCharCode(0x2014)
const order = async () =>
  ProfiOrder.parse(
    JSON.parse(await readFile(join(ROOT, 'tests/fixtures/orders/90000001.json'), 'utf8')),
  )

/** A gateway that answers the given results in turn and keeps every input it was sent. */
function stubGateway(results: (AnalystOutput | null)[]) {
  const inputs: string[] = []
  const options: (CallOptions | undefined)[] = []
  const gw: Gateway = {
    async call<T>(
      _role: string,
      input: string,
      _schema: unknown,
      opts?: CallOptions,
    ): Promise<RoleCallResult<T>> {
      inputs.push(input)
      options.push(opts)
      const out = results[inputs.length - 1] ?? null
      return out
        ? { ok: true, output: out as T, durationMs: 1, modelCallId: 'm' }
        : { ok: false, errorClass: 'timeout', message: 'no', durationMs: 1, modelCallId: 'm' }
    },
  }
  return { gw, inputs, options }
}
const READING = {
  said: 'Сайт клиники: услуги, врачи, онлайн-запись, логотип есть',
  layers: 'Сама назвала, что нужно; хочет готовый результат, а не стратегию',
  wants: 'Начать записывать пациентов онлайн без долгого запуска',
  who: 'Владелец или управляющий небольшой клиники',
  risks: 'Сроки не названы; «с нуля» может оказаться больше, чем звучит',
  job: 'Чтобы запись шла сама и не терялись звонки',
}
const ANALYSIS = {
  hidden_need: 'Боится долгого запуска',
  risk: 'Объём больше, чем звучит',
  condition: 'Брать, если сроки и состав сайта понятны',
}
const answer = (text: string, price: number | null = 90000): AnalystOutput => ({
  reading: READING,
  ...ANALYSIS,
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

describe("Boris's price in his answer (K2)", () => {
  it('FR-LEAD-6: a price on its own line is taken out of the text', () => {
    expect(priceOf('Сделаем за неделю.\n\n5000 ₽')).toEqual({
      text: 'Сделаем за неделю.',
      priceRub: 5000,
    })
    expect(priceOf('Сделаем за неделю.\nцена 12 000')).toEqual({
      text: 'Сделаем за неделю.',
      priceRub: 12000,
    })
    expect(priceOf('Стоимость: 7 500 руб.\nСделаем.')).toEqual({ text: 'Сделаем.', priceRub: 7500 })
  })

  it('FR-LEAD-6: a price alone changes only the price', () => {
    expect(priceOf('цена 5000')).toEqual({ text: null, priceRub: 5000 })
    expect(priceOf('Цена: 5\u00a0000 рублей.')).toEqual({ text: null, priceRub: 5000 })
    expect(priceOf('30 000 ₽')).toEqual({ text: null, priceRub: 30000 })
  })

  it('FR-LEAD-6: a sum inside a sentence is text, not the price', () => {
    expect(priceOf('Сайт обойдётся в 5000 ₽, сроки неделя.')).toEqual({
      text: 'Сайт обойдётся в 5000 ₽, сроки неделя.',
      priceRub: null,
    })
    expect(priceOf('цена 0')).toEqual({ text: 'цена 0', priceRub: null })
    expect(priceOf('цена 3000000000')).toEqual({ text: 'цена 3000000000', priceRub: null })
  })

  it('FR-LEAD-6: an answer to the price question may be a bare number', () => {
    expect(priceOf('5000', { bare: true })).toEqual({ text: null, priceRub: 5000 })
    expect(priceOf('5 000', { bare: true })).toEqual({ text: null, priceRub: 5000 })
    expect(priceOf('5000')).toEqual({ text: '5000', priceRub: null })
    expect(priceOf('пять тысяч', { bare: true })).toEqual({ text: 'пять тысяч', priceRub: null })
  })
})

describe('the Analyst', () => {
  it('FR-LEAD-6: the Analyst answers the reading first, the text last', () => {
    const props = Object.keys(
      (roleJsonSchema(AnalystOutput) as { properties: Record<string, unknown> }).properties,
    )
    // The reading comes first, the text and the price last, and the optional case ids after them.
    expect(props).toEqual([
      'reading',
      'hidden_need',
      'risk',
      'condition',
      'text',
      'price_rub',
      'case_ids',
    ])
    const reading = (
      roleJsonSchema(AnalystOutput) as {
        properties: { reading: { properties: Record<string, unknown> } }
      }
    ).properties.reading
    expect(Object.keys(reading.properties)).toEqual([
      'said',
      'layers',
      'wants',
      'who',
      'risks',
      'job',
    ])
  })

  it('FR-LEAD-6: the разбор comes with the draft', async () => {
    const { gw } = stubGateway([answer(BODY)])
    expect(await writeDraft(gw, await order())).toMatchObject({
      text: `Ирина, добрый день!\n\n${BODY}`,
      analysis: { ...ANALYSIS, reading: READING },
    })
  })

  it('FR-LEAD-6: a text too long twice still keeps the reading', async () => {
    const { gw } = stubGateway([answer('а'.repeat(600)), answer('б'.repeat(600))])
    expect(await writeDraft(gw, await order())).toMatchObject({
      text: null,
      reason: 'too_long',
      analysis: { ...ANALYSIS, reading: READING },
    })
  })

  it('FR-LEAD-6: the Analyst never sees the client name and is told the length left', async () => {
    const { gw, inputs } = stubGateway([answer(BODY)])
    const d = await writeDraft(gw, await order())
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).not.toContain('Ирина')
    expect(inputs[0]).toContain('Нужен сайт для клиники')
    expect(inputs[0]).toContain('Длина текста: не больше 479 знаков')
    expect(d).toMatchObject({
      text: `Ирина, добрый день!\n\n${BODY}`,
      priceRub: 90000,
      attempts: 1,
    })
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
    expect(await writeDraft(gw, await order())).toMatchObject({
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
    expect(await writeDraft(gw, await order())).toMatchObject({
      text: null,
      reason: 'not_plain',
      attempts: 2,
    })
    expect(inputs[1]).toContain('не простой текст')
  })

  it('NFR-PRIV-2: the Analyst call hides the client name the board and the order page gave', async () => {
    const { gw, options } = stubGateway([answer(BODY)])
    await writeDraft(gw, {
      ...(await order()),
      client_info: { name: 'Ирина Петрова' },
    })
    expect(options[0]?.redact?.names).toEqual(['Ирина', 'Ирина Петрова'])
  })

  it('NFR-PRIV-2: a name the site hides is not given to the redaction as a name', async () => {
    const { gw, options } = stubGateway([answer(BODY)])
    await writeDraft(gw, { ...(await order()), client_name: 'Клиент 7' })
    expect(options[0]?.redact?.names).toEqual([])
  })

  it('NFR-PRIV-2: a tag the model made up never stays in the draft: it is asked again, then no draft', async () => {
    const { gw, inputs } = stubGateway([
      answer('Понимаю, [имя 4]. Когда запуск?'),
      answer('Смотрите [ссылка 2]. Когда запуск?'),
    ])
    expect(await writeDraft(gw, await order())).toMatchObject({
      text: null,
      reason: 'has_tag',
      attempts: 2,
    })
    expect(inputs[1]).toContain('квадратных скобках')
  })

  it('NFR-PRIV-2: any square-bracketed word in a draft is refused, the tag forms the model invents included', async () => {
    for (const text of [
      'Понимаю, [Имя]. Когда запуск?',
      'Смотрите [ссылка на сайт]. Когда запуск?',
    ]) {
      const { gw, inputs } = stubGateway([answer(text), answer(text)])
      expect(await writeDraft(gw, await order())).toMatchObject({
        text: null,
        reason: 'has_tag',
        attempts: 2,
      })
      expect(inputs[1]).toContain('квадратных скобках')
    }
  })

  it('NFR-PRIV-2: a second answer without tags is the draft', async () => {
    const { gw } = stubGateway([answer('Понимаю, [имя 4]. Когда запуск?'), answer(BODY)])
    expect(await writeDraft(gw, await order())).toMatchObject({
      text: `Ирина, добрый день!\n\n${BODY}`,
      attempts: 2,
    })
  })

  it('FR-LEAD-6: a failed Analyst call gives no draft', async () => {
    const { gw } = stubGateway([null])
    expect(await writeDraft(gw, await order())).toEqual({
      text: null,
      reason: 'no_answer',
      attempts: 1,
      analysis: null,
    })
  })

  it('FR-LEAD-6: a price above the client budget leaves the field empty', async () => {
    const { gw } = stubGateway([answer(BODY, 300000)])
    expect(await writeDraft(gw, await order())).toMatchObject({
      text: `Ирина, добрый день!\n\n${BODY}`,
      priceRub: null,
      attempts: 1,
    })
  })
})

describe('what the Analyst is told about the client', () => {
  const info = {
    name: 'Ирина',
    on_profi_since: 'На Профи.ру с 7 сентября 2020',
    phone_verified: true,
    reviews: { positive: 3, negative: 1 },
    review_tags: ['Перестала отвечать', 'Торгуется'],
  }

  it('FR-LEAD-6: the client facts of the order page go to the Analyst, the name does not', async () => {
    const o = await order()
    const input = analystInput({ ...o, client_info: info }, 400)
    expect(input).toContain(
      'Клиент на площадке: На Профи.ру с 7 сентября 2020; номер подтверждён; отзывы специалистов: 3 хороших, 1 плохой; отметки в отзывах: Перестала отвечать, Торгуется',
    )
    expect(input).not.toContain('Ирина')
  })

  it('FR-LEAD-6: what the page did not show is left out, an unverified number is said', async () => {
    const o = await order()
    const input = analystInput(
      {
        ...o,
        client_info: {
          name: null,
          on_profi_since: null,
          phone_verified: false,
          reviews: null,
          review_tags: [],
        },
      },
      400,
    )
    expect(input).toContain('Клиент на площадке: номер не подтверждён')
    expect(input).not.toContain('отзывы')
  })

  it('FR-LEAD-6: without client info the Analyst input is as before', async () => {
    const o = await order()
    expect(analystInput(o, 400)).not.toContain('Клиент на площадке')
    expect(analystInput({ ...o, client_info: null }, 400)).toBe(analystInput(o, 400))
  })
})

const CASE = {
  id: 'clinic_site',
  title: 'Сайт клиники',
  url: 'https://hance.example/cases/clinic',
  summary: 'Запись онлайн, плюс 40% обращений',
  tags: ['сайт', 'медицина'],
  show_when: 'Клиенту нужен сайт услуг с записью',
  never_when: null,
}
const FORMAT = {
  parts: [
    { id: 'understanding', title: 'Понимание', hint: 'Про ситуацию клиента' },
    { id: 'question', title: 'Вопрос', hint: 'Один короткий вопрос' },
  ],
  max_chars: 500,
  tone: ['спокойно, без клише'],
  examples: [],
  max_cases: 2,
}
const PROFILE = { reply_format: FORMAT, cases: [CASE] }

describe('the Analyst reads the direction (FR-LEAD-6)', () => {
  it('FR-LEAD-6: a profile with no format and no cases gives the very input the Analyst always had', async () => {
    const o = await order()
    expect(analystInput(o, 479)).toBe(analystInput(o, 479, ''))
    const old = stubGateway([answer(BODY)])
    await writeDraft(old.gw, o)
    const none = stubGateway([answer(BODY)])
    await writeDraft(none.gw, o, { profile: { reply_format: null, cases: [] } })
    expect(none.inputs).toEqual(old.inputs)
  })

  it('FR-LEAD-6: the input carries the direction format and the case rules, and no link', async () => {
    const { gw, inputs } = stubGateway([answer(BODY)])
    await writeDraft(gw, await order(), { profile: PROFILE })
    expect(inputs[0]).toContain('Формат отклика этого направления')
    expect(inputs[0]).toContain('clinic_site: Сайт клиники')
    expect(inputs[0]).toContain('Показывай, когда: Клиенту нужен сайт услуг с записью')
    expect(inputs[0]).not.toContain('https://')
    expect(inputs[0]).not.toContain('Ирина')
  })

  it('FR-LEAD-6: case_ids from the model become the library links, and the greeting is still first', async () => {
    const { gw } = stubGateway([{ ...answer(BODY), case_ids: ['clinic_site', 'nope'] }])
    const d = await writeDraft(gw, await order(), { profile: PROFILE })
    expect(d).toMatchObject({ cases: ['clinic_site'] })
    expect((d as { text: string }).text).toBe(
      `Ирина, добрый день!\n\n${BODY}\n\nПохожая работа: Сайт клиники, https://hance.example/cases/clinic`,
    )
  })

  it('FR-LEAD-6: the model is told a shorter length by the room kept for the cases', async () => {
    const { gw, inputs } = stubGateway([answer(BODY)])
    await writeDraft(gw, await order(), { profile: PROFILE })
    const reserve = 2 + 'Похожая работа: Сайт клиники, https://hance.example/cases/clinic'.length
    expect(inputs[0]).toContain(`Длина текста: не больше ${479 - reserve} знаков`)
  })

  it('FR-LEAD-6: a text that fits the ceiling but not the cases room is kept, and the cases that do not fit are left out', async () => {
    const reserve = 2 + 'Похожая работа: Сайт клиники, https://hance.example/cases/clinic'.length
    const body = 'а'.repeat(479 - reserve + 5)
    const { gw } = stubGateway([{ ...answer(body), case_ids: ['clinic_site'] }])
    const d = await writeDraft(gw, await order(), { profile: PROFILE })
    expect(d).toMatchObject({ attempts: 1, cases: [], text: `Ирина, добрый день!\n\n${body}` })
  })

  it('FR-LEAD-6: a text longer than the whole ceiling is asked once more, saying so', async () => {
    const { gw, inputs } = stubGateway([answer('а'.repeat(480)), answer('Коротко. Когда запуск?')])
    const d = await writeDraft(gw, await order(), { profile: PROFILE })
    expect(d.attempts).toBe(2)
    expect(inputs[1]).toContain('Прошлый вариант вышел')
  })

  it('FR-LEAD-6: the room kept for the cases never leaves the model less than 150 characters', async () => {
    const tight = { ...PROFILE, reply_format: { ...FORMAT, max_chars: 200, max_cases: 1 } }
    const { gw, inputs } = stubGateway([answer('б'.repeat(160))])
    const d = await writeDraft(gw, await order(), { profile: tight })
    expect(inputs[0]).toContain('Длина текста: не больше 150 знаков')
    // 19 + 2 + 160 fits the 200 of the format, so the draft stands (the case is left out).
    expect(d).toMatchObject({ attempts: 1, cases: [] })
  })

  it('FR-LEAD-6: the format own max_chars is the ceiling the model is told and the text is held to', async () => {
    const small = { ...PROFILE, reply_format: { ...FORMAT, max_chars: 200, max_cases: 0 } }
    const { gw, inputs } = stubGateway([answer('б'.repeat(300)), answer('Коротко. Когда запуск?')])
    const d = await writeDraft(gw, await order(), { profile: small })
    expect(inputs[0]).toContain('Длина текста: не больше 179 знаков')
    expect(d.attempts).toBe(2)
    expect((d as { text: string }).text.length).toBeLessThanOrEqual(200)
  })

  it('FR-LEAD-6: a draft without the cases field is as before', async () => {
    const { gw } = stubGateway([answer(BODY)])
    const d = await writeDraft(gw, await order(), { profile: PROFILE })
    expect(d).toMatchObject({ cases: [], text: `Ирина, добрый день!\n\n${BODY}` })
  })

  it('FR-LEAD-6: the Analyst case_ids come last in its schema and are not required', () => {
    const schema = roleJsonSchema(AnalystOutput) as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(Object.keys(schema.properties).at(-1)).toBe('case_ids')
    expect(schema.required).not.toContain('case_ids')
  })
})
