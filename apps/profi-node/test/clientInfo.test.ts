import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ClientInfo } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { clientInfoFromAnswer } from '../src/eyes/clientInfo'
import { profiParsers } from '../src/eyes/profiParsers'

const ROOT = resolve(import.meta.dirname, '../../../tests/fixtures/profi/response')
const sample = (name: string) => JSON.parse(readFileSync(join(ROOT, `${name}.json`), 'utf8'))

const answer = (data: Record<string, unknown>) => ({ data })

describe('the client answer of the order page (getKlientInfo)', () => {
  it("FR-LEAD-5: the site's own lines about the client are kept: the words, the colour and the percent (Profi Pro, 01.11.2026)", () => {
    const info = clientInfoFromAnswer(sample('klient-info-pro').body)
    expect(info?.summaries).toEqual([
      {
        description: 'Договаривается меньше, чем в 20% заказов',
        color_theme: 'RED',
        percent: 20,
      },
      { description: 'Обычно отвечает в течение часа', color_theme: 'GREEN', percent: null },
    ])
    expect(ClientInfo.safeParse(info).success).toBe(true)
    // The contacts beside them and the pictures stay in the answer.
    expect(JSON.stringify(info)).not.toMatch(/\+7|cdn\.profi|image/)
  })

  it('FR-LEAD-5: the lines are known by their shape, wherever the list sits and whatever it is called', () => {
    const line = { colorTheme: 'RED', description: 'Договаривается в 5 % заказов' }
    const base = { title: 'На Профи.ру с 2020' }
    const want = [{ description: 'Договаривается в 5 % заказов', color_theme: 'RED', percent: 5 }]
    expect(clientInfoFromAnswer(answer({ ...base, stats: [line] }))?.summaries).toEqual(want)
    expect(clientInfoFromAnswer(answer({ ...base, block: { stats: [line] } }))?.summaries).toEqual(
      want,
    )
    // The same line twice is one line.
    expect(clientInfoFromAnswer(answer({ ...base, a: [line], b: [line] }))?.summaries).toEqual(want)
  })

  it('FR-LEAD-5: nothing else passes for such a line: no contacts, no text without a colour, no percent over 100', () => {
    const base = { title: 'На Профи.ру с 2020' }
    const line = { colorTheme: 'RED', description: 'Телефон +70000000000' }
    expect(
      clientInfoFromAnswer(answer({ ...base, contacts: { list: [line] } })),
    ).not.toHaveProperty('summaries')
    expect(
      clientInfoFromAnswer(answer({ ...base, notes: [{ description: 'Слова клиента' }] })),
    ).not.toHaveProperty('summaries')
    const big = clientInfoFromAnswer(
      answer({ ...base, stats: [{ colorTheme: 'RED', description: 'Рост 300%' }] }),
    )
    expect(big?.summaries?.[0]?.percent).toBeNull()
  })

  it('FR-LEAD-5: an answer without such lines has no summaries at all, as before', () => {
    expect(clientInfoFromAnswer(sample('klient-info').body)).not.toHaveProperty('summaries')
  })

  it('FR-LEAD-5: the sample gives the name, the date on Profi.ru, the verified number, the reviews and their tags', () => {
    expect(clientInfoFromAnswer(sample('klient-info').body)).toEqual({
      name: 'Ирина',
      on_profi_since: 'На Профи.ру с 7 сентября 2020',
      phone_verified: true,
      reviews: { positive: 3, negative: 1 },
      review_tags: ['Перестала отвечать', 'Вежливый клиент', 'Чётко ставит задачу'],
    })
    expect(ClientInfo.safeParse(clientInfoFromAnswer(sample('klient-info').body)).success).toBe(
      true,
    )
  })

  it('FR-LEAD-5: labels without «Номер подтверждён» say the number is not verified, no labels say nothing', () => {
    const base = { name: 'Ирина', title: 'На Профи.ру с 1 января 2024', reviews: null }
    expect(
      clientInfoFromAnswer(answer({ ...base, labels: [{ text: 'Новый клиент' }] }))?.phone_verified,
    ).toBe(false)
    expect(clientInfoFromAnswer(answer({ ...base, labels: [] }))?.phone_verified).toBe(false)
    expect(clientInfoFromAnswer(answer({ ...base }))?.phone_verified).toBe(null)
  })

  it('FR-LEAD-5: labels and tags may come as plain words or as objects with a text', () => {
    const info = clientInfoFromAnswer(
      answer({
        name: 'Ирина',
        title: 'На Профи.ру с 1 января 2024',
        labels: ['Номер подтверждён'],
        reviews: {
          count: { positive: 0, negative: 2 },
          list: [{ tags: ['Торгуется', { title: 'Не платит' }] }],
        },
      }),
    )
    expect(info).toMatchObject({
      phone_verified: true,
      reviews: { positive: 0, negative: 2 },
      review_tags: ['Торгуется', 'Не платит'],
    })
  })

  it('FR-LEAD-5: a page that shows no reviews gives null reviews and no tags', () => {
    expect(
      clientInfoFromAnswer(
        answer({ name: 'Ирина', title: 'На Профи.ру с 1 января 2024', labels: [] }),
      ),
    ).toEqual({
      name: 'Ирина',
      on_profi_since: 'На Профи.ру с 1 января 2024',
      phone_verified: false,
      reviews: null,
      review_tags: [],
    })
  })

  it('FR-LEAD-5: no more than 10 tags are kept, the newest first', () => {
    const tags = Array.from({ length: 14 }, (_, i) => `Тег ${i + 1}`)
    const info = clientInfoFromAnswer(
      answer({
        name: 'Ирина',
        title: 'На Профи.ру с 1 января 2024',
        labels: [],
        reviews: { count: { positive: 14, negative: 0 }, list: tags.map((t) => ({ tags: [t] })) },
      }),
    )
    expect(info?.review_tags).toEqual(tags.slice(0, 10))
  })

  it('FR-LEAD-5: the contacts the answer carries never leave it', () => {
    const info = clientInfoFromAnswer(
      answer({
        name: 'Ирина',
        title: 'На Профи.ру с 1 января 2024',
        labels: [],
        contacts: { phone: '70000000000', email: 'x@example.test' },
        phone: '70000000000',
      }),
    )
    expect(JSON.stringify(info)).not.toMatch(/70000000000|example\.test/)
  })

  it('FR-LEAD-5: the profile answer, the interface data and a broken body are not a client answer', () => {
    expect(clientInfoFromAnswer(sample('profile').body)).toBeNull()
    expect(clientInfoFromAnswer(sample('interface-data').body)).toBeNull()
    expect(clientInfoFromAnswer(null)).toBeNull()
    expect(clientInfoFromAnswer({ data: { reviews: 'x' } })).toBeNull()
  })

  it('FR-LEAD-5: the backoffice answer reader knows the client answer and keeps it quiet', () => {
    const s = sample('klient-info')
    expect(profiParsers.fromResponse(s.url, s.body)).toEqual({
      recognized: true,
      what: 'client',
      signals: [],
    })
  })
})
