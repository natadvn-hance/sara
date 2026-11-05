import type { ClientInfo, LeadScreen } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead } from '../src/db/schema'
import {
  type Check,
  checkedOf,
  clarifyLines,
  type FormParts,
  forgetFormParts,
  formPartsOf,
  loadFormParts,
  mergeScreens,
  negativeReviews,
  newAccount,
  ownWords,
  screenEvent,
  screenLines,
  screenOf,
  screenSummary,
  senseMarks,
  shortText,
  sinceDay,
  splitParts,
  VACANCY_PENALTY,
  vacancy,
  vacancySoft,
} from '../src/leads/screen'
import { dryReport, dryScreen } from '../src/leads/screenDry'
import { openTestDb, resetDb } from './helpers/db'

const NONE: FormParts = { parts: new Set(), labels: new Set() }
/** The form as the site writes it: parts and labels seen in three different orders. */
const FORM = formPartsOf([
  'Лендинг · Платформа: по рекомендации специалиста · Функционал сайта: запись · Контента нет',
  'Лендинг · Платформа: по рекомендации специалиста · Функционал сайта: каталог · Контента нет',
  'Лендинг · Платформа: по рекомендации специалиста · Функционал сайта: блог · Контента нет',
])
const info = (p: Partial<ClientInfo>): ClientInfo => ({
  name: null,
  on_profi_since: null,
  phone_verified: null,
  reviews: null,
  review_tags: [],
  ...p,
})
const at = (iso: string) => new Date(iso)
const words = (n: number) => Array.from({ length: n }, (_, i) => `слово${i}`).join(' ')

describe('the form of Profi.ru is told from the client words', () => {
  it('a part repeated word for word in three orders is the form, in two it is not', () => {
    const two = formPartsOf(['А · Платформа: Тильда', 'Б · Платформа: Тильда'])
    expect(two.parts.has('платформа: тильда')).toBe(false)
    expect(FORM.parts.has('платформа: по рекомендации специалиста')).toBe(true)
    expect(FORM.parts.has('лендинг')).toBe(true)
    // The label repeats although each answer differs: the label is the form's, the answer the client's.
    expect(FORM.labels.has('функционал сайта')).toBe(true)
    expect(FORM.parts.has('функционал сайта: запись')).toBe(false)
  })

  it('one order repeating a part counts once', () => {
    const f = formPartsOf(['Да · Да · Да'])
    expect(f.parts.size).toBe(0)
  })

  it('the board joins parts with a middle dot, the page with lines', () => {
    expect(splitParts('Лендинг · Платформа: Тильда\nКонтента нет')).toEqual([
      'Лендинг',
      'Платформа: Тильда',
      'Контента нет',
    ])
  })

  it('form answers are not counted, a form label keeps the client answer, anything else counts', () => {
    const w = ownWords(
      {
        title: 'Создание сайта',
        text: 'Лендинг · Платформа: по рекомендации специалиста · Функционал сайта: онлайн запись клиентов · Контента нет · Хотим больше заявок',
      },
      FORM,
    )
    expect(w).toEqual([
      'Создание',
      'сайта',
      'онлайн',
      'запись',
      'клиентов',
      'Хотим',
      'больше',
      'заявок',
    ])
  })

  it('a title the text already has, or the form knows, is not counted twice', () => {
    expect(ownWords({ title: 'Лендинг', text: 'Сделать быстро' }, FORM)).toEqual([
      'Сделать',
      'быстро',
    ])
    expect(ownWords({ title: 'Оформить канал', text: 'Тема: Оформить канал' }, NONE)).toEqual([
      'Тема',
      'Оформить',
      'канал',
    ])
  })

  it('numbers alone are not words', () => {
    expect(ownWords({ title: '', text: 'Бюджет 50 000, срок 2 недели' }, NONE)).toEqual([
      'Бюджет',
      'срок',
      'недели',
    ])
  })
})

describe('criterion 3: fewer than 15 own words, softened (31.10.2026)', () => {
  it('14 own words are a soft mark, not a stop, with the words as the basis', () => {
    const c = shortText({ title: '', text: words(14) }, NONE, 15)
    expect(c).toMatchObject({ soft: { criterion: 'short_text' } })
    expect(c && 'soft' in c ? c.soft.basis : '').toMatch(
      /^своими словами 14 слов: «слово0 .*в ответах формы 0 слов$/,
    )
  })

  it('an order with no own words and next to no answers of the form is empty and stops', () => {
    for (const text of ['50 000', 'Лендинг · Контента нет']) {
      const c = shortText({ title: 'Лендинг', text }, FORM, 15)
      expect(c).toEqual({
        hit: {
          criterion: 'short_text',
          basis: 'пустой заказ: нет ни своих слов, ни ответов формы',
        },
      })
    }
  })

  it('15 own words pass', () => {
    expect(shortText({ title: '', text: words(15) }, NONE, 15)).toEqual({ pass: 'short_text' })
  })

  it('answers of the form count as text: no own words but a filled form is a soft mark', () => {
    const c = shortText(
      {
        title: 'Лендинг',
        text: 'Лендинг · Платформа: по рекомендации специалиста · Контента нет',
      },
      FORM,
      15,
    )
    expect(c).toMatchObject({ soft: { criterion: 'short_text' } })
    expect(c && 'soft' in c ? c.soft.basis : '').toMatch(
      /^своих слов нет, в ответах формы \d+ слов/,
    )
  })

  it('the threshold is a setting', () => {
    expect(shortText({ title: '', text: words(9) }, NONE, 10)).toMatchObject({ soft: {} })
    expect(shortText({ title: '', text: words(10) }, NONE, 10)).toEqual({ pass: 'short_text' })
  })

  it('an order without text is no data, never short', () => {
    expect(shortText({ title: 'Сайт', text: '  ' }, NONE, 15)).toEqual({ noData: 'short_text' })
  })
})

describe('criterion 1: the account was made on the day of the order', () => {
  it('reads the site date with a year, without one, and today', () => {
    expect(sinceDay('На Профи.ру с 7 сентября 2020', '2026-10-30')).toBe('2020-09-07')
    expect(sinceDay('На Профи.ру с 30 октября', '2026-10-30')).toBe('2026-10-30')
    expect(sinceDay('На Профи.ру с 31 декабря', '2026-01-02')).toBe('2025-12-31')
    expect(sinceDay('На Профи.ру с 3 мая 2024', '2026-10-30')).toBe('2024-05-03')
    expect(sinceDay('На Профи.ру с сегодня', '2026-10-30')).toBe('2026-10-30')
    expect(sinceDay('Давно на Профи.ру', '2026-10-30')).toBeNull()
  })

  it('fires on the same Moscow day, with the field as the basis', () => {
    // 22:30 UTC on the 29th is the 30th in Moscow.
    expect(
      newAccount(
        info({ on_profi_since: 'На Профи.ру с 30 октября 2026' }),
        at('2026-10-29T22:30:00Z'),
      ),
    ).toEqual({
      hit: {
        criterion: 'new_account',
        basis: '«На Профи.ру с 30 октября 2026», заявка от 30.10.2026',
      },
    })
  })

  it('a day earlier does not fire', () => {
    expect(
      newAccount(
        info({ on_profi_since: 'На Профи.ру с 29 октября 2026' }),
        at('2026-10-30T10:00:00Z'),
      ),
    ).toEqual({ pass: 'new_account' })
  })

  it('no profile, no date, or a date the code cannot read is no data', () => {
    const when = at('2026-10-30T10:00:00Z')
    expect(newAccount(null, when)).toEqual({ noData: 'new_account' })
    expect(newAccount(info({}), when)).toEqual({ noData: 'new_account' })
    expect(newAccount(info({ on_profi_since: 'Новый клиент' }), when)).toEqual({
      noData: 'new_account',
    })
  })
})

describe('criterion 2: three or more negative reviews', () => {
  it('three fire, two do not', () => {
    expect(negativeReviews(info({ reviews: { positive: 5, negative: 3 } }))).toEqual({
      hit: { criterion: 'negative_reviews', basis: 'негативных отзывов 3, положительных 5' },
    })
    expect(negativeReviews(info({ reviews: { positive: 0, negative: 2 } }))).toEqual({
      pass: 'negative_reviews',
    })
  })

  it('no reviews data is no data', () => {
    expect(negativeReviews(null)).toEqual({ noData: 'negative_reviews' })
    expect(negativeReviews(info({ reviews: null }))).toEqual({ noData: 'negative_reviews' })
  })
})

describe('criteria 4-6: the sense of the task, with a quote', () => {
  const o = { title: 'Реклама', text: 'Нужно настроить рекламу в Директе для салона.' }

  it('a core with its quote in the order fires', () => {
    expect(
      senseMarks(o, [
        { criterion: 'direct', verdict: 'core', quote: 'настроить рекламу в Директе' },
      ]),
    ).toEqual({
      hits: [{ criterion: 'direct', basis: '«настроить рекламу в Директе»' }],
      clarify: [],
    })
  })

  it('the quote is matched without case, ё, quotes and extra spaces', () => {
    expect(
      senseMarks(o, [
        { criterion: 'direct', verdict: 'core', quote: '«НАСТРОИТЬ  рекламу в директе»' },
      ]).hits,
    ).toHaveLength(1)
  })

  it('a core whose quote is not in the order does not fire: no basis, the order goes on to clarify', () => {
    expect(
      senseMarks(o, [{ criterion: 'direct', verdict: 'core', quote: 'вести Директ каждый день' }]),
    ).toEqual({ hits: [], clarify: [{ criterion: 'direct', basis: '«вести Директ каждый день»' }] })
  })

  it('a doubt between core and background goes the order way, marked to clarify', () => {
    expect(
      senseMarks({ title: '', text: 'Поправить кнопку и выстроить воронку' }, [
        { criterion: 'small_fix', verdict: 'unclear', quote: 'Поправить кнопку' },
      ]),
    ).toEqual({ hits: [], clarify: [{ criterion: 'small_fix', basis: '«Поправить кнопку»' }] })
  })

  it('an older answer without the screen is no hit', () => {
    expect(senseMarks(o, undefined)).toEqual({ hits: [], clarify: [] })
  })
})

describe('the rules of application', () => {
  const when = new Date('2026-10-30T10:00:00Z')

  it('every criterion that fired is listed, in Boris order, each with its basis', () => {
    const s = screenOf(
      [
        newAccount(info({ on_profi_since: 'На Профи.ру с 30 октября 2026', reviews: null }), when),
        negativeReviews(null),
        shortText({ title: '', text: '50 000' }, NONE, 15),
      ],
      { hits: [{ criterion: 'direct', basis: '«настроить Директ»' }] },
      { stops: true, ownWords: 0, at: when },
    )
    expect(s.hits.map((h) => h.criterion)).toEqual(['new_account', 'short_text', 'direct'])
    expect(s.no_data).toEqual(['negative_reviews'])
    expect(screenLines(s)).toEqual([
      '⛔ ОТСЕЯН - Новый аккаунт - «На Профи.ру с 30 октября 2026», заявка от 30.10.2026',
      '⛔ ОТСЕЯН - Короткий текст - пустой заказ: нет ни своих слов, ни ответов формы',
      '⛔ ОТСЕЯН - Яндекс Директ - «настроить Директ»',
    ])
    for (const l of screenLines(s)) expect(l).not.toContain(String.fromCharCode(0x2014))
  })

  it('a later check replaces the no data of an earlier one and keeps what it found', () => {
    const first = screenOf(
      [{ noData: 'new_account' }, { noData: 'negative_reviews' }, { pass: 'short_text' }],
      { clarify: [{ criterion: 'wordpress', basis: '«на WordPress»' }] },
      { stops: true, ownWords: 40, at: when },
    )
    const checks: Check[] = [
      { pass: 'new_account' },
      negativeReviews(info({ reviews: { positive: 1, negative: 4 } })),
    ]
    const page = screenOf(checks, {}, { stops: true, ownWords: 40, at: when })
    const s = mergeScreens(first, page, checkedOf(checks))
    expect(s.no_data).toEqual([])
    expect(s.hits.map((h) => h.criterion)).toEqual(['negative_reviews'])
    expect(s.clarify.map((c) => c.criterion)).toEqual(['wordpress'])
    expect(s.own_words).toBe(40)
  })

  it('the journal gets the criteria, never the quotes', () => {
    const s: LeadScreen = {
      stops: true,
      hits: [{ criterion: 'direct', basis: '«настроить рекламу в Директе»' }],
      clarify: [{ criterion: 'small_fix', basis: '«поправить кнопку»' }],
      no_data: ['new_account'],
      soft: [],
      penalty: 0,
      own_words: 20,
      at: when.toISOString(),
    }
    const e = screenEvent(s)
    expect(e).toEqual({
      stops: true,
      out: true,
      criteria: ['direct'],
      clarify: ['small_fix'],
      soft: [],
      penalty: 0,
      no_data: ['new_account'],
      own_words: 20,
    })
    expect(JSON.stringify(e)).not.toContain('Директе')
  })

  it('an account made on the day of the order stops it with the switch off too (Boris, 01.11.2026)', () => {
    const made = newAccount(
      {
        name: null,
        on_profi_since: 'На Профи.ру с 1 ноября',
        phone_verified: null,
        reviews: null,
        review_tags: [],
      },
      new Date('2026-11-01T16:03:00Z'),
    )
    expect(screenOf([made], {}, { stops: false, ownWords: 8, at: when }).stops).toBe(true)
    // Another criterion with the switch off only marks.
    const other = { hit: { criterion: 'direct' as const, basis: 'x' } }
    expect(screenOf([other], {}, { stops: false, ownWords: 8, at: when }).stops).toBe(false)
    // The board's text knew nothing of the account; the page tells, and the merge keeps the stop.
    const byText = screenOf(
      [{ noData: 'new_account' }],
      {},
      { stops: false, ownWords: 8, at: when },
    )
    const merged = mergeScreens(
      byText,
      screenOf([made], {}, { stops: false, ownWords: 8, at: when }),
      ['new_account'],
    )
    expect(merged.stops).toBe(true)
    expect(merged.no_data).toEqual([])
    // An account of another day does not stop.
    const old = newAccount(
      {
        name: null,
        on_profi_since: 'На Профи.ру с 8 ноября',
        phone_verified: null,
        reviews: null,
        review_tags: [],
      },
      new Date('2026-11-01T16:03:00Z'),
    )
    expect(screenOf([old], {}, { stops: false, ownWords: 8, at: when }).stops).toBe(false)
  })

  it('the summary counts stopped orders by criterion, and says when the screen only marks', () => {
    const hit = (c: LeadScreen['hits'][number]['criterion']) => ({ criterion: c, basis: 'x' })
    expect(
      screenSummary([
        { stops: true, hits: [hit('short_text')] },
        { stops: true, hits: [hit('short_text'), hit('direct')] },
        { stops: true, hits: [] },
      ]),
    ).toBe('Отсеяно 2: Короткий текст 2, Яндекс Директ 1')
    expect(screenSummary([{ stops: false, hits: [hit('new_account')] }])).toBe(
      'Отсеяла бы 1 (отсев пока только отмечает): Новый аккаунт 1',
    )
    expect(screenSummary([{ stops: true, hits: [] }])).toBeNull()
    expect(
      screenSummary([
        { stops: true, hits: [hit('new_account')] },
        { stops: false, hits: [hit('short_text')] },
      ]),
    ).toBe(
      'Отсеяно 1: Новый аккаунт 1. Отсеяла бы ещё 1 (отсев пока только отмечает): Короткий текст 1',
    )
  })
})

describe('the form is learned from the orders in the database', () => {
  const { db, close } = openTestDb()
  afterAll(close)
  beforeEach(async () => {
    await resetDb(db)
    forgetFormParts()
  })

  it('parts and labels of three different recent orders are the form', async () => {
    const row = (id: string, text: string) => ({
      id,
      accountId: 'hance-marketing',
      title: 'Сайт',
      category: 'Сайт',
      city: 'Москва',
      text,
      clientName: '',
      budgetText: null,
      bidPriceRub: 0,
      seenAt: new Date().toISOString(),
      correlationId: '00000000-0000-4000-8000-000000000001',
    })
    await db
      .insert(lead)
      .values([
        row('1', 'Лендинг · Платформа:  по рекомендации специалиста · Цель: продажи'),
        row('2', 'Лендинг\nПлатформа: по рекомендации специалиста\nЦель: имидж'),
        row('3', 'Лендинг · Платформа: по рекомендации специалиста · Цель: заявки · Свой текст'),
        row('4', 'Свой текст · Свой текст'),
      ])
    const f = await loadFormParts(db)
    expect([...f.parts].sort()).toEqual(['лендинг', 'платформа: по рекомендации специалиста'])
    expect([...f.labels].sort()).toEqual(['платформа', 'цель'])
  })
})

describe('the dry run counts what the screen would stop, without the client words', () => {
  it('counts per criterion, the shown and bid ones, and lists those for a check by hand', () => {
    const row = (
      id: string,
      text: string,
      extra: Partial<Parameters<typeof dryScreen>[0][number]> = {},
    ) => ({
      id,
      title: '',
      text,
      clientInfo: null,
      seenAt: '2026-10-30T10:00:00.000Z',
      shown: false,
      bid: false,
      ...extra,
    })
    const r = dryScreen(
      [
        row('1', words(20)),
        row('2', '100', { shown: true }),
        row('3', words(20), {
          clientInfo: info({ reviews: { positive: 0, negative: 5 } }),
          shown: true,
          bid: true,
        }),
        row('4', ''),
      ],
      NONE,
      15,
    )
    expect(r.out).toEqual({ n: 2, shown: 2, bid: 1 })
    expect(r.by.short_text).toEqual({ n: 1, shown: 1, bid: 0 })
    expect(r.by.negative_reviews).toEqual({ n: 1, shown: 1, bid: 1 })
    expect(r.noData).toMatchObject({ new_account: 4, negative_reviews: 3, short_text: 1 })
    expect(r.lost.map((l) => l.id)).toEqual(['2', '3'])
    const report = dryReport(r, 15)
    expect(report).toContain('остановил бы 2 (50%), из них показанных 2, с откликом 1')
    expect(report).not.toContain('Нужен сайт')
  })
})

describe('criterion 7: a text that is a vacancy', () => {
  const JOB = {
    title: 'Маркетолог',
    text: 'Ищем маркетолога в команду. Обязанности: ведение рекламы, отчёты. Требования: опыт от 2 лет. Оклад от 80 тыс. в месяц, график 5/2, полный день.',
  }

  it('a clear vacancy (sections with pay or schedule, several signs) stops, with its quotes as the basis', () => {
    const c = vacancy(JOB)
    expect(c).toMatchObject({ hit: { criterion: 'vacancy' } })
    const basis = c && 'hit' in c ? c.hit.basis : ''
    expect(basis).toContain('разделы: «Обязанности»')
    expect(basis).toContain('график')
    expect(vacancySoft(JOB)).toBeNull()
  })

  it('a text that only looks like one is not stopped, it is marked to lose points', () => {
    const like = {
      title: 'Маркетолог',
      text: 'Нужен маркетолог в команду, ищем сотрудника на постоянку, подробности обсудим.',
    }
    expect(vacancy(like)).toEqual({ pass: 'vacancy' })
    expect(vacancySoft(like)).toMatchObject({ criterion: 'vacancy' })
    const lines = clarifyLines({
      clarify: [],
      soft: [vacancySoft(like) as NonNullable<ReturnType<typeof vacancySoft>>],
      penalty: VACANCY_PENALTY,
    })
    expect(lines[0]).toContain('Похоже на вакансию (минус 15 баллов)')
    expect(lines[0]).toContain('только человек в штат или и внешняя команда')
  })

  it('«Постоянная работа» under a role in the category is a sign, alone with the title it is not enough', () => {
    expect(
      vacancySoft({
        title: 'Маркетолог',
        text: 'Продвижение. Постоянная работа. Ищем ещё сотрудника.',
      }),
    ).not.toBeNull()
    expect(vacancySoft({ title: 'Дизайн', text: 'Постоянная работа. Логотип.' })).toBeNull()
  })

  it('a project where «команда» is just a word, or one sign alone, passes clean', () => {
    const project = {
      title: 'Стратегия',
      text: 'У нас команда из пяти человек, хотим понять, как расти. Нужен агентство-партнёр под ключ.',
    }
    expect(vacancy(project)).toEqual({ pass: 'vacancy' })
    expect(vacancySoft(project)).toBeNull()
    expect(vacancySoft({ title: '', text: 'Наша команда делает мебель, нужен сайт.' })).toBeNull()
  })

  it('sections and pay from an agency project are not a vacancy: the project sign wins', () => {
    const t = {
      title: 'Агентство',
      text: 'Ищем агентство. Требования: кейсы. Условия: оплата 80 тыс. в месяц, график встреч раз в неделю.',
    }
    expect(vacancy(t)).toEqual({ pass: 'vacancy' })
  })

  it('no text is no data', () => {
    expect(vacancy({ title: 'Маркетолог', text: ' ' })).toEqual({ noData: 'vacancy' })
  })
})
