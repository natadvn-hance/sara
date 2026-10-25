import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { CaseHit } from '../../src/conversation/types'
import { readShowRules } from '../../src/mind/cases'
import { ensureMindIndex } from '../../src/mind/indexer'
import { CASE_MIN_RANK, createMindSearch } from '../../src/mind/search'
import { openTestDb, resetDb } from '../helpers/db'
import { putRecord, tempMind } from '../helpers/mind'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const DIR = 'hance-marketing'
const mind = createMindSearch(db)
const caseOf = (hits: CaseHit[], id: string): CaseHit => {
  const hit = hits.find((h) => h.id === id)
  if (!hit) throw new Error(`no case ${id} in ${hits.map((h) => h.id).join(', ')}`)
  return hit
}

type Case = {
  id: string
  title: string
  tags?: string[]
  summary: string
  result?: string | null
  /** The items of «Как показывать клиенту»; null leaves the section out. */
  rules?: string[] | null
  /** The texts of the other sections; the defaults are the same for every case. */
  work?: string
  where?: string
  role?: string
  period?: string
  state?: string
  materials?: string
  front?: Record<string, unknown>
}

/** An invented case in the format of the sara-mind case records. */
function caseText(c: Case): string {
  const parts = [
    `# ${c.title}`,
    c.summary,
    `## Что делали\n${c.work ?? 'Собрали сайт и настроили рекламу.'}`,
  ]
  parts.push(`## Где\n${c.where ?? 'Tilda, Яндекс Директ'}`)
  parts.push(`## Роль и масштаб\n${c.role ?? 'Под ключ. Команда: 2 человека.'}`)
  if (c.result !== null) parts.push(`## Результат\n${c.result ?? 'Сто заявок за месяц.'}`)
  parts.push(`## Срок\n${c.period ?? '20 рабочих дней'}`)
  if (c.materials) parts.push(`## Материалы\n${c.materials}`)
  if (c.rules !== null)
    parts.push(
      `## Как показывать клиенту\n${(c.rules ?? ['Компанию и ссылку можно называть.']).map((r) => `- ${r}`).join('\n')}`,
    )
  parts.push(`## Состояние описания\n${c.state ?? 'Факты подтверждены Борисом.'}`)
  return parts.join('\n\n')
}

async function putCase(root: string, c: Case): Promise<void> {
  await putRecord(
    root,
    `mind/shared/knowledge/cases/${c.id}.md`,
    { id: c.id, type: 'knowledge', title: c.title, tags: c.tags ?? ['кейс'], ...c.front },
    caseText(c),
  )
}

const CEILINGS: Case = {
  id: 'k-case-01',
  title: 'Потолок-Арт: подвесные потолки, Санкт-Петербург',
  tags: ['кейс', 'яндекс директ', 'сайт'],
  summary:
    'Построили для Потолок-Арт управляемый поток заявок через сайт и Яндекс Директ: 90 заявок за первый месяц.\n\nВторой абзац не нужен.',
  result: '90 заявок за первый месяц при бюджете рекламы 40 000 ₽.',
  rules: [
    'Компанию и ссылку можно называть.',
    'Цифры из «Результата» можно называть как есть, не округляя в свою пользу.',
  ],
}
const CLINIC: Case = {
  id: 'k-case-02',
  title: 'Сеть стоматологий: онлайн-запись, Краснодар',
  tags: ['Кейс', 'медицина'],
  summary: 'Перевели запись пациентов со звонков на онлайн-форму сети стоматологий.',
  result: 'Заявок стало в полтора раза больше за два месяца.',
  rules: [
    'Компанию не называть: NDA. Город и сфера можно.',
    'Цифры из «Результата» можно называть как есть, не округляя в свою пользу.',
  ],
}
const LOGISTICS: Case = {
  id: 'k-case-03',
  title: 'Логистическая компания: CRM и воронка продаж',
  tags: ['кейс', 'crm'],
  summary: 'Выстроили воронку продаж и подключили CRM для отдела логистики.',
  result: null,
  rules: ['Компанию не называть: NDA. Детали и название не раскрывать.'],
}
const STRATEGY: Case = {
  id: 'k-case-04',
  title: 'Школа танцев: стратегия маркетинга',
  tags: ['кейс'],
  summary: 'Разработали стратегию маркетинга и план роста для школы танцев.',
  result: null,
  rules: [
    'Компанию и ссылку можно называть.',
    'Результат не зафиксирован, цифр не называть.',
    'Подавать как разработку стратегии. Клиент не внедрял: о росте не говорить.',
  ],
}

async function casesMind(extra: Case[] = []): Promise<string> {
  const root = await tempMind()
  for (const c of [CEILINGS, CLINIC, LOGISTICS, STRATEGY, ...extra]) await putCase(root, c)
  await putRecord(
    root,
    'mind/shared/knowledge/k-price.md',
    { id: 'k-price', type: 'knowledge', title: 'Стоимость сайтов', tags: ['цена'], topic: 'price' },
    '## Факт\nЦену называет Борис после созвона.',
  )
  return root
}

describe('mind case search', () => {
  it('FR-MIND-2: a client about suspended ceilings finds the ceilings case in Russian word forms', async () => {
    await ensureMindIndex(db, await casesMind())
    const hits = await mind.cases?.({
      text: 'Здравствуйте, нужен сайт для натяжных и подвесных потолков, у вас был опыт с потолками?',
      scope: DIR,
      limit: 3,
    })
    expect(hits?.[0]?.id).toBe('k-case-01')
    expect(hits?.[0]).toMatchObject({
      id: 'k-case-01',
      type: 'knowledge',
      scope: 'shared',
      title: 'Потолок-Арт: подвесные потолки, Санкт-Петербург',
      rank: expect.any(Number),
    })
    expect(hits?.[0]?.rank).toBeGreaterThan(0)
    expect(hits?.[0]?.body).toMatch(/^Построили для Потолок-Арт/)

    const clinic = await mind.cases?.({
      text: 'онлайн запись пациентов в стоматологию',
      scope: DIR,
      limit: 3,
    })
    expect(clinic?.map((h) => h.id)).toEqual(['k-case-02'])
    expect(await mind.cases?.({ text: 'что как это', scope: DIR, limit: 3 })).toEqual([])
    expect(await mind.cases?.({ text: 'подвесные потолки', scope: DIR, limit: 0 })).toEqual([])
  })

  it('FR-MIND-2: the knowledge search never returns a case, the case search returns only cases', async () => {
    const root = await casesMind([
      {
        id: 'k-case-05',
        title: 'Интернет-магазин: сколько стоит запуск',
        // Tags with the words of a price question must not make a case a price fact.
        tags: ['кейс', 'стоит', 'сколько', 'цена'],
        summary:
          'Запустили интернет-магазин, цена запуска и сколько он стоит были согласованы заранее.',
      },
    ])
    await putRecord(
      root,
      'mind/shared/knowledge/k-about-cases.md',
      { id: 'k-about-cases', type: 'knowledge', title: 'Кейсы Hance', tags: ['портфолио'] },
      '## Факт\nКейсы показывает Борис на созвоне. Магазин, цена, сколько стоит запуск: это тоже обсуждается там.',
    )
    await putRecord(
      root,
      'mind/shared/speech/examples/e-case.md',
      { id: 'e-case', type: 'example', tags: ['кейс'] },
      '## Клиент\nСколько стоит магазин?\n\n## Борис\nДавайте созвонимся.',
    )
    await ensureMindIndex(db, root)
    const question = 'Сколько стоит интернет-магазин, какая цена?'

    const facts = await mind.search({ text: question, scope: DIR, types: ['knowledge'], limit: 20 })
    expect(facts.map((h) => h.id).sort()).toEqual(['k-about-cases', 'k-price'])
    const anyType = await mind.search({ text: question, scope: DIR, types: [], limit: 20 })
    expect(anyType.map((h) => h.id).filter((id) => id.startsWith('k-case'))).toEqual([])
    expect(anyType.map((h) => h.id)).toContain('e-case')

    const cases = (await mind.cases?.({ text: question, scope: DIR, limit: 20 })) ?? []
    expect(cases.map((h) => h.id)).toEqual(['k-case-05'])
    // A word of the title of every case; «сайт» and «реклама» are in the work of every case but only once, below the floor.
    const all =
      (await mind.cases?.({
        text: 'потолки стоматологии воронка стратегия магазин',
        scope: DIR,
        limit: 20,
      })) ?? []
    expect(all.map((h) => h.id).sort()).toEqual([
      'k-case-01',
      'k-case-02',
      'k-case-03',
      'k-case-04',
      'k-case-05',
    ])
    expect(all.map((h) => h.id)).not.toContain('k-price')
    expect(all.map((h) => h.id)).not.toContain('k-about-cases')
    expect(all.map((h) => h.id)).not.toContain('e-case')
  })

  it('FR-MIND-2: a case already told in the chat is left out', async () => {
    await ensureMindIndex(db, await casesMind())
    const q = { text: 'сайт и реклама, заявки, запись', scope: DIR, limit: 10 }
    const first = (await mind.cases?.(q)) ?? []
    expect(first.map((h) => h.id)).toContain('k-case-01')
    const told = (await mind.cases?.({ ...q, exclude: ['k-case-01'] })) ?? []
    expect(told.map((h) => h.id)).not.toContain('k-case-01')
    expect(told.map((h) => h.id)).toEqual(first.map((h) => h.id).filter((id) => id !== 'k-case-01'))
    const none = await mind.cases?.({ ...q, exclude: first.map((h) => h.id) })
    expect(none).toEqual([])
    expect(await mind.cases?.({ ...q, exclude: [] })).toEqual(first)
  })

  it('FR-MIND-2: the show rules of an NDA case close its name, rules that allow numbers open them', async () => {
    const noRules: Case = {
      id: 'k-case-06',
      title: 'Склад: учёт остатков',
      summary: 'Автоматизировали учёт остатков склада.',
      rules: null,
    }
    await ensureMindIndex(db, await casesMind([noRules]))
    const hits =
      (await mind.cases?.({
        text: 'сайт реклама заявки стратегия воронка склад учёт запись',
        scope: DIR,
        limit: 20,
      })) ?? []
    expect(hits.map((h) => h.id).sort()).toEqual([
      'k-case-01',
      'k-case-02',
      'k-case-03',
      'k-case-04',
      'k-case-06',
    ])

    const ceilings = caseOf(hits, 'k-case-01')
    expect(ceilings).toMatchObject({
      summary:
        'Построили для Потолок-Арт управляемый поток заявок через сайт и Яндекс Директ: 90 заявок за первый месяц.',
      result: '90 заявок за первый месяц при бюджете рекламы 40 000 ₽.',
      showRules: [
        'Компанию и ссылку можно называть.',
        'Цифры из «Результата» можно называть как есть, не округляя в свою пользу.',
      ],
      nameOpen: true,
      numbersOpen: true,
    })

    expect(caseOf(hits, 'k-case-02')).toMatchObject({
      showRules: [
        'Компанию не называть: NDA. Город и сфера можно.',
        'Цифры из «Результата» можно называть как есть, не округляя в свою пользу.',
      ],
      nameOpen: false,
      numbersOpen: true,
    })
    expect(caseOf(hits, 'k-case-03')).toMatchObject({
      summary: 'Выстроили воронку продаж и подключили CRM для отдела логистики.',
      result: null,
      showRules: ['Компанию не называть: NDA. Детали и название не раскрывать.'],
      nameOpen: false,
      numbersOpen: false,
    })
    // «цифр не называть» is about the numbers: the company may still be named.
    expect(caseOf(hits, 'k-case-04')).toMatchObject({
      result: null,
      nameOpen: true,
      numbersOpen: false,
    })
    // A record without the section shows nothing it was not allowed to.
    expect(caseOf(hits, 'k-case-06')).toMatchObject({
      showRules: [],
      nameOpen: false,
      numbersOpen: false,
    })
  })

  it('FR-MIND-2: a rule about numbers that both allows and forbids them keeps them closed, wrapped rules are read whole', async () => {
    const mixed: Case = {
      id: 'k-case-07',
      title: 'Кофейня: сайт и доставка',
      summary: 'Сделали сайт доставки для кофейни.',
      rules: [
        'Цифры можно называть, если Борис разрешил.',
        'Цифры нельзя называть до созвона.',
        'Компанию и ссылку можно\n  называть.',
      ],
    }
    const root = await tempMind()
    await putCase(root, mixed)
    await ensureMindIndex(db, root)
    const [hit] =
      (await mind.cases?.({ text: 'сайт доставки кофейни', scope: DIR, limit: 3 })) ?? []
    expect(hit).toMatchObject({
      id: 'k-case-07',
      numbersOpen: false,
      nameOpen: true,
      showRules: [
        'Цифры можно называть, если Борис разрешил.',
        'Цифры нельзя называть до созвона.',
        'Компанию и ссылку можно называть.',
      ],
    })
  })

  it('FR-MIND-1: a direction case is found only for its account, and only a confirmed case in force', async () => {
    const root = await casesMind()
    await putRecord(
      root,
      `mind/directions/${DIR}/knowledge/cases/k-case-90.md`,
      { id: 'k-case-90', type: 'knowledge', scope: DIR, title: 'Только маркетинг', tags: ['кейс'] },
      caseText({
        id: 'k-case-90',
        title: 'Только маркетинг',
        summary: 'Кейс про аналитику и воронку.',
      }),
    )
    await putCase(root, {
      id: 'k-case-91',
      title: 'Черновик про воронку',
      summary: 'Кейс про воронку, ещё не подтверждён.',
      front: { status: 'proposal' },
    })
    await ensureMindIndex(db, root)
    const own = await mind.cases?.({ text: 'аналитика воронка', scope: DIR, limit: 10 })
    expect(own?.map((h) => h.id)).toContain('k-case-90')
    expect(own?.map((h) => h.id)).not.toContain('k-case-91')
    const other = await mind.cases?.({
      text: 'аналитика воронка',
      scope: 'hance-design',
      limit: 10,
    })
    expect(other?.map((h) => h.id)).not.toContain('k-case-90')
  })
})

describe('mind case search: what is read and what is asked', () => {
  /** A micro-case written the way the real ones are: its rules and its state talk about examples of work. */
  const MICRO: Case = {
    id: 'k-case-13',
    title: 'Парсинг базы для отдела продаж',
    tags: ['кейс', 'парсинг'],
    summary: 'Собрали базу контактов компаний для отдела продаж.',
    work: 'Выгрузка из открытых источников и очистка.',
    where: 'Python',
    role: 'Комплексная работа с данными, один исполнитель.',
    result: 'Пока не зафиксировано',
    rules: [
      'Компанию и ссылку можно называть.',
      'Микро-кейс: только как дополнительный пример работ, не как главный.',
      'Приоритетный кейс для портфолио.',
    ],
    state: 'Черновик: нужно дополнить примеры работ и результаты, есть ли отзыв.',
  }

  it('FR-MIND-2: «А у вас есть примеры работ с натяжными потолками?» finds the ceilings case first and no micro-case', async () => {
    const root = await tempMind()
    for (const c of [MICRO, CEILINGS, STRATEGY]) await putCase(root, c)
    await ensureMindIndex(db, root)
    const hits =
      (await mind.cases?.({
        text: 'А у вас есть примеры работ с натяжными потолками?',
        scope: DIR,
        limit: 3,
      })) ?? []
    expect(hits.map((h) => h.id)).toEqual(['k-case-01'])
  })

  it('FR-MIND-2: the words that only ask for a case find no case, in any form', async () => {
    const root = await tempMind()
    for (const c of [MICRO, CEILINGS]) await putCase(root, c)
    await ensureMindIndex(db, root)
    for (const text of [
      'Есть ли у вас примеры работ?',
      'Покажите кейсы',
      'А портфолио у вас есть?',
      'Пришлите пример вашей работы или кейс',
      'работы, работ, работами, примерами, кейсами, портфолио',
    ]) {
      expect(await mind.cases?.({ text, scope: DIR, limit: 3 }), text).toEqual([])
    }
    // The asking words do not hide the rest of the question.
    const hits =
      (await mind.cases?.({ text: 'Покажите кейсы по парсингу баз', scope: DIR, limit: 3 })) ?? []
    expect(hits.map((h) => h.id)).toEqual(['k-case-13'])
  })

  it('FR-MIND-2: the index reads the title, tags, gist and the sections of the work, not the rules, the state or the materials', async () => {
    const root = await tempMind()
    await putCase(root, {
      id: 'k-case-20',
      title: 'Мастерская Ветров',
      tags: ['кейс', 'гончарка'],
      summary: 'Запустили витрину керамики.\n\nВторой абзац про ковёр.',
      work: 'Снимали рилсы.',
      where: 'Телеграм',
      role: 'Наставничество.',
      result: 'Выручка выросла.',
      period: 'Квартал.',
      materials: 'Папка с эскизами.',
      rules: ['Компанию можно называть.', 'Секретный хэштег.'],
      state: 'Черновик, нужны уточнения.',
    })
    await ensureMindIndex(db, root)
    // The words of the index itself, whatever the rank floor of the search.
    const found = async (word: string) =>
      (
        await db.execute<{ id: string }>(
          sql`select record_id as id from core.mind_index where tsv @@ plainto_tsquery('russian', ${word})`,
        )
      ).rows.map((r) => r.id)
    // Read: title, tag, first paragraph, «Что делали», «Где», «Роль и масштаб», «Результат».
    for (const word of [
      'мастерская',
      'гончарка',
      'витрину',
      'рилсы',
      'телеграм',
      'наставничество',
      'выручка',
    ])
      expect(await found(word), word).toEqual(['k-case-20'])
    // Not read: the second paragraph, «Срок», «Материалы», «Как показывать клиенту», «Состояние описания», the tag «кейс».
    for (const word of [
      'ковёр',
      'квартал',
      'эскизами',
      'хэштег',
      'секретный',
      'уточнения',
      'черновик',
      'кейс',
    ])
      expect(await found(word), word).toEqual([])
  })

  it('FR-MIND-2: a stock «not recorded yet» in a field is not a word of the case', async () => {
    const root = await tempMind()
    await putCase(root, { ...MICRO, result: 'Пока не зафиксировано' })
    await ensureMindIndex(db, root)
    expect(await mind.cases?.({ text: 'зафиксировано пока', scope: DIR, limit: 3 })).toEqual([])
  })

  it('FR-MIND-2: the client words come first, a long order text after them cannot push them out', async () => {
    const root = await tempMind()
    await putCase(root, CEILINGS)
    await ensureMindIndex(db, root)
    const filler = Array.from({ length: 80 }, (_, i) => `слово${i}`).join(' ')
    const first = await mind.cases?.({ text: `натяжные потолки ${filler}`, scope: DIR, limit: 3 })
    expect(first?.map((h) => h.id)).toEqual(['k-case-01'])
    // The cap is on the first 32 distinct words: a word after them is not asked.
    const last = await mind.cases?.({ text: `${filler} потолки`, scope: DIR, limit: 3 })
    expect(last).toEqual([])
  })

  it('FR-MIND-2: a question far from every case gets no case, a word met once in a gist is below the floor', async () => {
    const root = await tempMind()
    // «реклам» is met once in the work of each case; nothing in the mind is about dentists.
    for (const c of [LOGISTICS, STRATEGY]) await putCase(root, c)
    await ensureMindIndex(db, root)
    const far = await mind.cases?.({
      text: 'Нужна реклама для стоматологии',
      scope: DIR,
      limit: 3,
    })
    expect(far).toEqual([])
    // Every hit is at or above the floor; a word of the title is far above it.
    const near = (await mind.cases?.({ text: 'стратегия маркетинга', scope: DIR, limit: 3 })) ?? []
    expect(near.map((h) => h.id)).toEqual(['k-case-04'])
    for (const h of near) expect(h.rank).toBeGreaterThanOrEqual(CASE_MIN_RANK)
  })
})

describe('show rules', () => {
  const NAME = 'Компанию и ссылку можно называть.'
  const NUMBERS = 'Цифры из «Результата» можно называть как есть, не округляя в свою пользу.'

  it.each([
    [[NAME], true, false],
    [[NAME, NUMBERS], true, true],
    [['Компанию не называть: NDA. Город и сфера можно.'], false, false],
    [['Компанию не называть: NDA. Город и сфера можно.', NUMBERS], false, true],
    [
      ['Компанию, отрасль и чувствительные детали не называть: NDA. Говорить о подходе.'],
      false,
      false,
    ],
    [['Компанию не называть: NDA. Детали и название не раскрывать.'], false, false],
    [
      [
        'Цифр результата нет: говорить о том, что сделали, не обещать и не придумывать результат.',
        NAME,
      ],
      true,
      false,
    ],
    [['Результат не зафиксирован, цифр не называть.', NAME], true, false],
    [['Компанию не называть, цифры можно называть.'], false, true],
    [['Цифры и компанию не называть.'], false, false],
    [['Цифры можно называть.', 'Цифры нельзя называть до созвона.'], true, false],
    [['Микро-кейс: только как дополнительный пример; компания не названа.'], true, false],
    [['Приоритетный кейс для портфолио.'], true, false],
    [[], false, false],
  ])('FR-MIND-2: the rules %j give name %s and numbers %s', (rules, nameOpen, numbersOpen) => {
    expect(readShowRules(rules)).toEqual({ nameOpen, numbersOpen })
  })
})
