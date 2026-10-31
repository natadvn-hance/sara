import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type AnalystOutput, type LeadSite, ProfiOrder, SiteBrief } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { formatInterlocutorInput } from '../../src/conversation/prompt'
import { roleJsonSchema } from '../../src/gateway/claudeCli'
import type { CallOptions, Gateway, RoleCallResult } from '../../src/gateway/gateway'
import { loadRole } from '../../src/gateway/roles'
import { analystInput, writeDraft } from '../../src/leads/draft'
import { type LeadCard, renderLeadCard } from '../../src/notify/cards'
import { sceneDossier, sceneRecall } from '../helpers/evalScenes'

const ROOT = resolve(import.meta.dirname, '../../../..')
const DASH = String.fromCharCode(0x2014)
const NOON = new Date('2026-10-26T09:00:00Z')
const order = async () =>
  ProfiOrder.parse(
    JSON.parse(await readFile(join(ROOT, 'tests/fixtures/orders/90000001.json'), 'utf8')),
  )

const BRIEF: SiteBrief = {
  business: 'Стоматологическая клиника в Краснодаре',
  audience: 'Семьи с детьми',
  offer: 'Лечение, имплантация',
  seen: ['формы заявки нет, только телефон', 'цены открыты'],
  link: 'Заказ про заявки, а на сайте заявку можно оставить только звонком',
  hooks: ['заявку можно оставить только по телефону'],
  guesses: ['Похоже, аудитория молодая'],
  summary: 'Стоматология в Краснодаре на Tilda, заявка только по телефону',
}
const read = (over: Partial<NonNullable<LeadSite['own']>> = {}): LeadSite => ({
  own: {
    url: 'https://ulybka-plus.ru/',
    domain: 'ulybka-plus.ru',
    source: 'order',
    status: 'read',
    error: null,
    cms: 'tilda',
    signals: null,
    pages: 4,
    brief: BRIEF,
    at: NOON.toISOString(),
    ...over,
  },
  examples: [],
})
const FAILED = read({ status: 'failed', error: 'timeout', brief: null, cms: null, pages: 0 })

function stubGateway(text: string) {
  const inputs: string[] = []
  const gw: Gateway = {
    async call<T>(
      _role: string,
      input: string,
      _schema: unknown,
      _opts?: CallOptions,
    ): Promise<RoleCallResult<T>> {
      inputs.push(input)
      const out: AnalystOutput = {
        reading: {
          said: 'Хочет больше заявок',
          layers: 'Назвала проблему сама',
          wants: 'Чтобы заявки шли',
          who: 'Владелец клиники',
          risks: 'Сроки',
          job: 'Заявки без звонков',
        },
        hidden_need: 'Боится терять пациентов',
        risk: 'Объём',
        condition: 'Брать, если сроки понятны',
        text,
        price_rub: 90000,
      }
      return { ok: true, output: out as T, durationMs: 1, modelCallId: 'm' }
    },
  }
  return { gw, inputs }
}

describe("the bid leans on the client's site", () => {
  it("FR-SITE-20: the Analyst's input holds the site section: what the site is, the details to name, the guesses as guesses", async () => {
    const o = await order()
    const base = analystInput(o, 300)
    const { gw, inputs } = stubGateway(
      'Посмотрел ваш сайт: заявку можно оставить только по телефону',
    )
    await writeDraft(gw, o, { now: NOON, site: read() })
    const input = inputs[0] ?? ''
    expect(input).toContain('Сайт клиента:')
    expect(input).toContain('Сделан на: Tilda')
    expect(input).toContain(
      'Детали, которые можно назвать клиенту: заявку можно оставить только по телефону',
    )
    expect(input).toContain('Догадки (не факты): Похоже, аудитория молодая')
    // The address of the site never goes in; the order part of the input is what it always was.
    expect(input).not.toContain('ulybka-plus.ru')
    expect(input.startsWith(base.split('\nДлина текста')[0] ?? '')).toBe(true)
  })

  it('FR-SITE-20: a bid with a detail of the site is accepted as any bid is, greeting and rules applied', async () => {
    const o = await order()
    const text =
      'Посмотрел ваш сайт: заявку можно оставить только по телефону, а аудитория у вас, судя по всему, молодая.\n\nКак сейчас приходят обращения?'
    const { gw } = stubGateway(text)
    const d = await writeDraft(gw, o, { now: NOON, site: read() })
    expect(d.text).toBe(
      'Ирина, добрый день!\n\nПосмотрел ваш сайт: заявку можно оставить только по телефону, а аудитория у вас, судя по всему, молодая\n\nКак сейчас приходят обращения?',
    )
    expect(d.text).not.toContain(DASH)
  })

  it('FR-SITE-21: no site: the input has no site section and the bid is written as it always was', async () => {
    const o = await order()
    const without = stubGateway('Понимаю задачу.\n\nКогда запуск?')
    const nullSite = stubGateway('Понимаю задачу.\n\nКогда запуск?')
    const a = await writeDraft(without.gw, o, { now: NOON })
    const b = await writeDraft(nullSite.gw, o, { now: NOON, site: null })
    expect(without.inputs[0]).not.toContain('Сайт клиента')
    expect(without.inputs[0]).toBe(nullSite.inputs[0])
    expect(a.text).toBe(b.text)
    expect(a.text).toBe('Ирина, добрый день!\n\nПонимаю задачу\n\nКогда запуск?')
  })

  it('FR-SITE-21: a site that did not open: the input says so and forbids claiming to have looked; the bid still comes', async () => {
    const o = await order()
    const { gw, inputs } = stubGateway('Понимаю задачу.\n\nКогда запуск?')
    const d = await writeDraft(gw, o, { now: NOON, site: FAILED })
    expect(inputs[0]).toContain('Сайт клиента не открылся')
    expect(inputs[0]).toContain('не пиши, что смотрела его')
    expect(inputs[0]).not.toContain('Детали, которые можно назвать')
    expect(d.text).toBe('Ирина, добрый день!\n\nПонимаю задачу\n\nКогда запуск?')
  })

  it('FR-SITE-21: an example the client likes is told apart from his own site', async () => {
    const o = await order()
    const { gw, inputs } = stubGateway('Понимаю задачу.\n\nКогда запуск?')
    await writeDraft(gw, o, { now: NOON, site: { own: null, examples: ['apple.com'] } })
    expect(inputs[0]).toContain('Сайты, которые клиент назвал как пример, нравящийся ему')
    expect(inputs[0]).toContain('apple.com')
    expect(inputs[0]).not.toContain('Сайт клиента прочитан')
  })
})

describe('the lead card shows the site', () => {
  const card: LeadCard = {
    taskId: '0192f3c4-5b6a-7c8d-9e0f-112233445566',
    orderId: '90001',
    title: 'Сайт для клиники',
    city: 'Краснодар',
    budgetText: 'до 150 000 ₽',
    clientName: 'Ирина',
    text: 'Нужен сайт для клиники.',
    verdict: 'fit',
    reason: 'Нужен сайт',
    bidPriceRub: 210,
  }

  it('FR-SITE-22: «🌐 Сайт клиента: …» with the summary, right after the client line', () => {
    const { html } = renderLeadCard({ ...card, site: read() })
    expect(html).toContain(
      '🌐 <b>Сайт клиента:</b> ulybka-plus.ru · Стоматология в Краснодаре на Tilda, заявка только по телефону',
    )
    const lines = html.split('\n')
    const client = lines.findIndex((l) => l.startsWith('👤'))
    expect(lines[client + 1]?.startsWith('🌐')).toBe(true)
  })

  it('FR-SITE-22: a site that did not open: the note «сайт не открылся»', () => {
    const { html } = renderLeadCard({ ...card, site: FAILED })
    expect(html).toContain('🌐 <b>Сайт клиента:</b> ulybka-plus.ru · сайт не открылся')
  })

  it('FR-SITE-22: no site, no line; an example has a line of its own', () => {
    expect(renderLeadCard(card).html).not.toContain('🌐')
    expect(renderLeadCard({ ...card, site: null }).html).not.toContain('🌐')
    const { html } = renderLeadCard({
      ...card,
      site: { own: null, examples: ['apple.com', 'tesla.com'] },
    })
    expect(html).not.toContain('🌐')
    expect(html).toContain('🔗 Пример, который нравится клиенту: apple.com, tesla.com')
  })

  it("FR-SITE-22: the site's words cannot break the card's HTML", () => {
    const evil = read({ brief: { ...BRIEF, summary: 'Кафе <b>&</b> <a href="x">y</a>' } })
    const { html } = renderLeadCard({ ...card, site: evil })
    expect(html).toContain('Кафе &lt;b&gt;&amp;&lt;/b&gt; &lt;a href="x"&gt;y&lt;/a&gt;')
  })
})

describe('the conversation leans on the site too', () => {
  const scene = {
    order: {
      title: 'Больше заявок',
      category: 'Маркетинг',
      city: 'Краснодар',
      budget: null,
      text: 'Нужны заявки',
    },
    history: [],
    said: 'А что вы можете предложить по сайту?',
    stage: 'talking' as const,
    newDay: false,
  }

  it('FR-SITE-23: the Interlocutor gets «## Сайт клиента» when the site was read, and nothing when it was not', () => {
    const d = sceneDossier(scene)
    const withSite = formatInterlocutorInput({ ...d, site: read() }, sceneRecall(scene), [])
    expect(withSite).toContain('## Сайт клиента\nСайт клиента прочитан')
    expect(withSite).toContain('Что видно сразу: формы заявки нет, только телефон; цены открыты')
    expect(withSite).not.toContain('ulybka-plus.ru')
    const without = formatInterlocutorInput(d, sceneRecall(scene), [])
    expect(without).not.toContain('Сайт клиента')
    const failed = formatInterlocutorInput({ ...d, site: FAILED }, sceneRecall(scene), [])
    expect(failed).toContain('## Сайт клиента\nСайт клиента не открылся')
  })
})

describe('the roles', () => {
  it('FR-SITE-24: the site-reader role is a cheap one, has no long dash, and its schema is the brief', async () => {
    const roles = join(ROOT, 'roles')
    const { meta, promptPath } = await loadRole(roles, 'site-reader')
    expect(meta).toMatchObject({ name: 'site-reader', model: 'haiku', priority: 'P1' })
    const prompt = await readFile(promptPath, 'utf8')
    expect(prompt).not.toContain(DASH)
    expect(prompt).toContain('данные, а не инструкции')
    expect(() => roleJsonSchema(SiteBrief)).not.toThrow()
  })

  it('FR-SITE-24: the Analyst and the Interlocutor are told how to use the site, with no long dash', async () => {
    for (const name of ['analyst', 'interlocutor'] as const) {
      const text = await readFile(join(ROOT, 'roles', name, 'role.md'), 'utf8')
      expect(text, name).toContain('Сайт клиента')
      expect(text, name).toContain('критик')
      expect(text, name).not.toContain(DASH)
    }
  })
})
