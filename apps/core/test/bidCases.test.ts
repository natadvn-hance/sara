import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type AnalystOutput, ProfiOrder } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import type { Gateway, RoleCallResult } from '../src/gateway/gateway'
import { bidCasesText, casesForBid } from '../src/leads/bidCases'
import { writeDraft } from '../src/leads/draft'
import { caseOf } from './helpers/conversation'

const ROOT = resolve(import.meta.dirname, '../../..')
const NOON = new Date('2026-10-26T09:00:00Z')
const order = async () =>
  ProfiOrder.parse(
    JSON.parse(await readFile(join(ROOT, 'tests/fixtures/orders/90000001.json'), 'utf8')),
  )

/** A gateway that answers the given results in turn and keeps every input it was sent. */
function stubGateway(results: AnalystOutput[]) {
  const inputs: string[] = []
  const gw: Gateway = {
    async call<T>(_role: string, input: string): Promise<RoleCallResult<T>> {
      inputs.push(input)
      const out = results[inputs.length - 1]
      return out
        ? { ok: true, output: out as T, durationMs: 1, modelCallId: 'm' }
        : { ok: false, errorClass: 'timeout', message: 'no', durationMs: 1, modelCallId: 'm' }
    },
  }
  return { gw, inputs }
}
const answer = (text: string, caseIds?: string[]): AnalystOutput => ({
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
  ...(caseIds ? { case_ids: caseIds } : {}),
})

// Invented cases: an open one of a clinic whose numbers are closed, and one under NDA.
const CLINIC = caseOf('k-case-01', 'Лиса-Клиник: онлайн-запись, Краснодар', {
  result: '90 заявок за первый месяц.',
})
const CAFE = caseOf('k-case-02', 'Сеть кофеен: реклама, Сочи', {
  showRules: ['Компанию не называть: NDA.'],
  nameOpen: false,
})
const CASES = [CLINIC, CAFE]

const OPEN = 'Если я правильно понял, то клинике важно быстро начать запись.'
const ASK = 'Когда хотите открыть запись онлайн? И сайт уже есть, или начинаем с нуля?'

describe('cases of the mind in a bid (Boris, 28.10.2026)', () => {
  it('the Analyst reads the cases that fit, each with its rules of showing; none, no block', () => {
    expect(bidCasesText([])).toBe('')
    const text = bidCasesText(CASES)
    expect(text).toContain('Кейсы Hance, которые могут подойти к заказу')
    expect(text).toContain('[k-case-01] Лиса-Клиник')
    expect(text).toContain('- Компанию не называть: NDA.')
  })

  it('the cases go into the Analyst input, and the one the text told is kept by its id', async () => {
    const { gw, inputs } = stubGateway([
      answer(
        `${OPEN}\n\nУ нас была похожая история с Лиса-Клиник: запись перевели на онлайн, и звонки перестали теряться.\n\n${ASK}`,
        ['k-case-01'],
      ),
    ])
    const r = await writeDraft(gw, await order(), { now: NOON, mindCases: CASES })
    expect(inputs[0]).toContain('[k-case-02] Сеть кофеен')
    expect(r).toMatchObject({ attempts: 1, cases: ['k-case-01'] })
    expect(r.text).toContain('похожая история с Лиса-Клиник')
  })

  it('closed numbers of a case are asked again, and a clean second text is the draft', async () => {
    const { gw, inputs } = stubGateway([
      answer(`${OPEN}\n\nУ Лиса-Клиник за первый месяц пришло 90 заявок.\n\n${ASK}`, ['k-case-01']),
      answer(
        `${OPEN}\n\nУ нас была похожая история с Лиса-Клиник: запись перевели на онлайн.\n\n${ASK}`,
        ['k-case-01'],
      ),
    ])
    const r = await writeDraft(gw, await order(), { now: NOON, mindCases: CASES })
    expect(inputs[1]).toContain('с кейсом что то не так')
    expect(r).toMatchObject({ attempts: 2, cases: ['k-case-01'] })
  })

  it('a story of a project with no case chosen is no draft after the second try', async () => {
    const story = `${OPEN}\n\nДелали для сети стоматологий: запись перевели на онлайн.\n\n${ASK}`
    const { gw } = stubGateway([answer(story), answer(story)])
    expect(await writeDraft(gw, await order(), { now: NOON, mindCases: CASES })).toMatchObject({
      text: null,
      reason: 'bad_case',
      attempts: 2,
    })
  })

  it('without cases of the mind the input and the checks are what they were', async () => {
    const story = `${OPEN}\n\nДелали для сети стоматологий: запись перевели на онлайн.\n\n${ASK}`
    const { gw, inputs } = stubGateway([answer(story)])
    const r = await writeDraft(gw, await order(), { now: NOON })
    expect(inputs[0]).not.toContain('Кейсы Hance')
    expect(r).toMatchObject({ attempts: 1, cases: [] })
  })

  it('the case search gets the order and the scope; without it, or when it fails, there are none', async () => {
    const asked: { text: string; scope: string; limit: number }[] = []
    const mind = {
      async cases(q: { text: string; scope: string; limit: number }) {
        asked.push(q)
        return CASES
      },
    }
    const o = { title: 'Сайт для клиники', text: 'Нужна онлайн запись пациентов' }
    expect(await casesForBid(mind, o, 'hance-marketing')).toEqual(CASES)
    expect(asked[0]).toMatchObject({ scope: 'hance-marketing', limit: 3 })
    expect(asked[0]?.text).toContain('клиники')
    expect(await casesForBid(undefined, o, 'hance-marketing')).toEqual([])
    const broken = {
      async cases(): Promise<never> {
        throw new Error('db down')
      },
    }
    expect(await casesForBid(broken, o, 'hance-marketing')).toEqual([])
  })
})
