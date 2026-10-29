import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type AnalystOutput, ProfiOrder } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { publicLink } from '../src/conversation/caseLink'
import type { Gateway, RoleCallResult } from '../src/gateway/gateway'
import { bidCasesText } from '../src/leads/bidCases'
import {
  followUpsEdit,
  followUpsOf,
  openerOf,
  recentOpenersText,
  writeDraft,
} from '../src/leads/draft'
import { seriesDelay } from '../src/leads/series'
import { type LeadCard, leadCardText } from '../src/notify/cards'
import { caseOf } from './helpers/conversation'

// The series after a bid (Boris, 29.10.2026). Every client, case and link here is invented.
const ROOT = resolve(import.meta.dirname, '../../..')
const NOON = new Date('2026-10-26T09:00:00Z')
const DASH = String.fromCharCode(0x2014)
const order = async () =>
  ProfiOrder.parse(
    JSON.parse(await readFile(join(ROOT, 'tests/fixtures/orders/90000001.json'), 'utf8')),
  )

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

const answer = (text: string, followUps?: AnalystOutput['follow_ups']): AnalystOutput => ({
  reading: {
    said: 'Сайт клиники с онлайн записью',
    layers: 'Сама назвала, что нужно',
    wants: 'Начать записывать пациентов онлайн',
    who: 'Владелец небольшой клиники',
    risks: 'Сроки не названы',
    job: 'Чтобы запись шла сама',
  },
  hidden_need: 'Боится долгого запуска',
  risk: 'Объём больше, чем звучит',
  condition: 'Брать, если сроки понятны',
  text,
  price_rub: 90000,
  ...(followUps ? { follow_ups: followUps } : {}),
})

const withSite = (id: string, title: string, url: string, rules: string[]) => {
  const c = caseOf(id, title, { showRules: rules })
  return { ...c, body: `${c.body}\n\n## Материалы\n\n${url}` }
}
// An open clinic with a public site, a clinic whose link is a working folder, and one under NDA with a site.
const CLINIC = withSite(
  'k-case-01',
  'Лиса-Клиник: онлайн-запись, Краснодар',
  'https://lisa-clinic.example/',
  ['Компанию и ссылку можно называть.'],
)
const FOLDER = withSite(
  'k-case-02',
  'Окна-Мастер: сайт, Москва',
  'https://drive.google.com/drive/folders/abc',
  ['Компанию и ссылку можно называть.'],
)
const CLOSED = {
  ...withSite('k-case-03', 'Сеть кофеен: реклама, Сочи', 'https://cafe.example/', [
    'Компанию не называть: NDA.',
  ]),
  nameOpen: false,
}
const CASES = [CLINIC, FOLDER, CLOSED]

const BID =
  'Прочитал описание, клинике важно быстро начать запись онлайн.\n\nКогда хотите открыть запись? И сайт уже есть, или начинаем с нуля?'

describe('the series after a bid: its texts (Boris, 29.10.2026)', () => {
  it('FR-LEAD-6: a case is shown only by a public link it may give: a site, never a folder or a closed company', () => {
    expect(publicLink(CLINIC)).toBe('https://lisa-clinic.example/')
    expect(publicLink(FOLDER)).toBeNull()
    expect(publicLink(CLOSED)).toBeNull()
    const text = bidCasesText(CASES)
    expect(text).toContain('[k-case-01] Лиса-Клиник')
    expect(text).toContain('Публичная ссылка: есть, её можно показать в серии')
    expect(text.match(/Публичная ссылка: нет/g)).toHaveLength(2)
  })

  it('FR-LEAD-6: the program puts the link of the chosen case on its own line; the second message is a human line', () => {
    const r = followUpsOf(
      [
        { text: 'Из недавнего, похожая задача)', case_id: 'k-case-01' },
        { text: 'Сделаем быстро, качественно и без лишних трат)', case_id: null },
      ],
      CASES,
    )
    expect(r).toEqual({
      texts: [
        'Из недавнего, похожая задача)\nhttps://lisa-clinic.example/',
        'Сделаем быстро, качественно и без лишних трат)',
      ],
      caseIds: ['k-case-01'],
      dropped: [],
    })
  })

  it('FR-LEAD-6: the voice rules hold for the series as for the bid: no long dash, no final period, no emoji', () => {
    const r = followUpsOf([{ text: `Сделаем ${DASH} быстро и спокойно. 🙂`, case_id: null }], [])
    expect(r.texts).toHaveLength(1)
    expect(r.texts[0]).not.toContain(DASH)
    expect(r.texts[0]).not.toMatch(/[.\u{1F642}]$/u)
  })

  it('FR-LEAD-6: a message that fails a check is left out and the rest stays', () => {
    const r = followUpsOf(
      [
        // A link the model wrote itself, a case without a public link, a greeting, too long, a case with no case.
        { text: 'Вот наш сайт lisa-clinic.ru', case_id: null },
        { text: 'Из недавнего)', case_id: 'k-case-02' },
      ],
      CASES,
    )
    expect(r).toEqual({ texts: [], caseIds: [], dropped: ['link', 'no_link'] })
    expect(
      followUpsOf([{ text: 'Добрый день! Из недавнего)', case_id: null }], []).dropped,
    ).toEqual(['greeting'])
    expect(followUpsOf([{ text: 'а'.repeat(201), case_id: null }], []).dropped).toEqual([
      'too_long',
    ])
    expect(
      followUpsOf(
        [{ text: 'Мы недавно сделали сайт для стоматологии в Сочи)', case_id: null }],
        CASES,
      ).dropped,
    ).toEqual(['bad_case'])
    // A case not in the list of this order is no case: its link is never put in.
    expect(followUpsOf([{ text: 'Из недавнего)', case_id: 'k-case-99' }], CASES).dropped).toEqual([
      'no_link',
    ])
  })

  it('FR-LEAD-6: the same case is shown once, and at most two messages follow a bid', () => {
    const twice = followUpsOf(
      [
        { text: 'Из недавнего)', case_id: 'k-case-01' },
        { text: 'И ещё вот)', case_id: 'k-case-01' },
      ],
      CASES,
    )
    expect(twice.texts).toHaveLength(1)
    expect(twice.dropped).toEqual(['no_link'])
    // The contract allows two; anything more the code never sends.
    const three = followUpsOf(
      [
        { text: 'Раз)', case_id: null },
        { text: 'Два)', case_id: null },
        { text: 'Три)', case_id: null },
      ] as AnalystOutput['follow_ups'],
      [],
    )
    expect(three.texts).toEqual(['Раз)', 'Два)'])
  })

  it('FR-LEAD-6: the draft carries the series the Analyst wrote with the bid', async () => {
    const { gw } = stubGateway([
      answer(BID, [
        { text: 'Из недавнего, похожая задача)', case_id: 'k-case-01' },
        { text: 'Сделаем быстро)', case_id: null },
      ]),
    ])
    const r = await writeDraft(gw, await order(), { now: NOON, mindCases: CASES })
    expect(r).toMatchObject({
      followUps: ['Из недавнего, похожая задача)\nhttps://lisa-clinic.example/', 'Сделаем быстро)'],
      followUpCases: ['k-case-01'],
      followUpsDropped: [],
    })
    // A bid without a series is a bid as before.
    const { gw: plain } = stubGateway([answer(BID)])
    expect(await writeDraft(plain, await order(), { now: NOON })).toMatchObject({
      followUps: [],
    })
  })

  it('FR-LEAD-6: Boris edits the series on the pult: the voice rules, empty messages gone, two at most', () => {
    expect(followUpsEdit([`Сделаем ${DASH} быстро.`, '  '])).toEqual(['Сделаем быстро'])
    expect(followUpsEdit(['Раз', 'Два', 'Три'])).toBeNull()
    expect(followUpsEdit(['а'.repeat(501)])).toBeNull()
    expect(followUpsEdit([])).toEqual([])
  })
})

describe('the bid opens differently from the latest ones (Boris, 29.10.2026)', () => {
  const SAME = 'Добрый день!\n\nЕсли я правильно понял, то студии важно заполнить мастер классы'

  it('FR-LEAD-6: the Analyst sees how the latest bids opened, each opening once', () => {
    expect(openerOf(SAME)).toBe('если я правильно понял')
    const text = recentOpenersText([
      SAME,
      SAME,
      'Анна, добрый день!\n\nХорошее описание, видно задачу',
    ])
    expect(text).toContain('начни этот по другому')
    expect(text.match(/«Если я правильно понял, то студии/g)).toHaveLength(1)
    expect(text).toContain('«Хорошее описание, видно задачу»')
    expect(recentOpenersText([])).toBe('')
  })

  it('FR-LEAD-6: the openings of the latest bids go into the Analyst input, without a second call', async () => {
    const { gw, inputs } = stubGateway([answer(BID)])
    const r = await writeDraft(gw, await order(), { now: NOON, recentBids: [SAME] })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toContain('Последние отклики начинались так')
    expect(inputs[0]).toContain('«Если я правильно понял, то студии важно заполнить мастер классы»')
    expect(r.text).toContain('Прочитал описание')
  })
})

describe('the series on the card and in time', () => {
  const card: LeadCard = {
    taskId: '00000000-0000-4000-8000-000000000001',
    orderId: '90000001',
    title: 'Сайт для клиники',
    city: 'Краснодар',
    budgetText: null,
    clientName: 'Анна',
    text: 'Нужен сайт клиники с онлайн записью.',
    verdict: 'fit',
    reason: 'Нужен сайт',
    bidPriceRub: 240,
    draft: {
      text: `Анна, добрый день!\n\n${BID}`,
      priceRub: 30000,
      followUps: ['Из недавнего)\nhttps://lisa-clinic.example/', 'Сделаем быстро)'],
    },
  }

  it('FR-LEAD-6: the card shows the series under the bid, each message on its own, approved by the same press', () => {
    const html = leadCardText(card)
    const bid = html.indexOf('Анна, добрый день!')
    const series = html.indexOf('Вдогонку, через 1-2 минуты после отклика')
    expect(bid).toBeGreaterThan(-1)
    expect(series).toBeGreaterThan(bid)
    expect(html).toContain('<blockquote>Из недавнего)\nhttps://lisa-clinic.example/</blockquote>')
    expect(html).toContain('<blockquote>Сделаем быстро)</blockquote>')
    expect(html).toContain('Уйдёт тем же нажатием, если клиент ещё не ответил')
    // A bid without a series: no such block at all.
    const none = leadCardText({ ...card, draft: { text: card.draft?.text ?? '', priceRub: 30000 } })
    expect(none).not.toContain('Вдогонку')
  })

  it('FR-LEAD-6: each message waits a minute or two, the same moment for the same order on a resume', () => {
    const range = [60_000, 120_000] as const
    for (const n of [0, 1]) {
      const ms = seriesDelay('95377001', n, range)
      expect(ms).toBeGreaterThanOrEqual(60_000)
      expect(ms).toBeLessThanOrEqual(120_000)
      expect(seriesDelay('95377001', n, range)).toBe(ms)
    }
  })
})
