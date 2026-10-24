import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mindIndex } from '../../src/db/schema'
import { ensureMindIndex } from '../../src/mind/indexer'
import { createMindSearch } from '../../src/mind/search'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'
import { putRecord, tempMind } from '../helpers/mind'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const DIR = 'hance-marketing'
const mind = createMindSearch(db)

async function priceMind(): Promise<string> {
  const root = await tempMind()
  await putRecord(
    root,
    'mind/shared/knowledge/k-price.md',
    { id: 'k-price', type: 'knowledge', title: 'Стоимость сайтов', tags: ['цена'], topic: 'price' },
    '## Факт\nЦену называет Борис после созвона.',
  )
  await putRecord(
    root,
    'mind/shared/knowledge/k-timeline.md',
    { id: 'k-timeline', type: 'knowledge', title: 'Сроки разработки', topic: 'timeline' },
    '## Факт\nОбычно от двух недель.',
  )
  return root
}

describe('mind search', () => {
  it('FR-MIND-2: a client question about the price finds the price record by Russian word forms', async () => {
    await ensureMindIndex(db, await priceMind())
    const hits = await mind.search({
      text: 'Добрый день, сколько стоит сайт?',
      scope: DIR,
      types: ['knowledge'],
      limit: 5,
    })
    expect(hits.map((h) => h.id)).toEqual(['k-price'])
    expect(hits[0]).toEqual({
      id: 'k-price',
      type: 'knowledge',
      scope: 'shared',
      title: 'Стоимость сайтов',
      body: '## Факт\nЦену называет Борис после созвона.',
      topic: 'price',
      tones: [],
      stages: [],
      exampleClient: null,
      exampleBoris: null,
      rank: expect.any(Number),
    })
    expect(hits[0]?.rank).toBeGreaterThan(0)
  })

  it('FR-MIND-2: hits come highest rank first and no more than the limit', async () => {
    const root = await tempMind()
    await putRecord(
      root,
      'mind/shared/knowledge/k-landing.md',
      { id: 'k-landing', type: 'knowledge', title: 'Лендинги', tags: ['лендинг'] },
      'Делаем лендинги. Лендинг за две недели.',
    )
    await putRecord(
      root,
      'mind/shared/knowledge/k-site.md',
      { id: 'k-site', type: 'knowledge', title: 'Сайты' },
      'Иногда к сайту нужен лендинг.',
    )
    await putRecord(
      root,
      'mind/shared/knowledge/k-ads.md',
      { id: 'k-ads', type: 'knowledge', title: 'Реклама' },
      'Реклама ведёт на лендинг.',
    )
    await ensureMindIndex(db, root)
    const all = await mind.search({ text: 'нужен лендинг', scope: DIR, types: [], limit: 10 })
    expect(all[0]?.id).toBe('k-landing')
    const ranks = all.map((h) => h.rank)
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
    expect(
      await mind.search({ text: 'нужен лендинг', scope: DIR, types: [], limit: 1 }),
    ).toHaveLength(1)
    expect(await mind.search({ text: 'да ок', scope: DIR, types: [], limit: 5 })).toEqual([])
  })

  it('FR-MIND-2: search answers under 300 ms on 1000 records', async () => {
    const words = ['сайт', 'лендинг', 'реклама', 'цена', 'сроки', 'дизайн', 'магазин', 'клиника']
    const words2 = ['договор', 'созвон', 'кейсы', 'бюджет', 'город', 'отзывы', 'логотип', 'текст']
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const title = `Запись ${i} ${words[i % 8]} ${words2[(i * 3) % 8]}`
      const body = `Про ${words[(i * 5) % 8]} и ${words2[(i * 7) % 8]}: запись номер ${i}.`
      return {
        recordId: `k-gen-${i}`,
        path: `mind/shared/knowledge/k-gen-${i}.md`,
        type: 'knowledge',
        scope: i % 2 === 0 ? 'shared' : DIR,
        title,
        body,
        version: 1,
        mindVersion: 'gen',
        tsv: sql`setweight(to_tsvector('russian', ${title}), 'A') || setweight(to_tsvector('russian', ${body}), 'B')`,
      }
    })
    await db.insert(mindIndex).values(rows)
    const texts = [
      'Сколько стоит сайт для клиники?',
      'Нужен лендинг и реклама',
      'Какие сроки у дизайна магазина',
      'Пришлите кейсы и отзывы',
      'Бюджет небольшой, договор нужен',
    ]
    let worst = 0
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      const hits = await mind.search({
        text: texts[i % texts.length] ?? '',
        scope: DIR,
        types: ['knowledge'],
        limit: 8,
      })
      worst = Math.max(worst, performance.now() - t0)
      expect(hits.length).toBeGreaterThan(0)
    }
    expect(worst).toBeLessThan(300)
  })

  it('FR-MIND-3: a proposal and an outdated record are not found', async () => {
    const root = await tempMind()
    const body = 'Гарантия на сайт один год.'
    const k = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      type: 'knowledge',
      ...extra,
    })
    await putRecord(root, 'mind/shared/knowledge/k-valid.md', k('k-valid'), body)
    await putRecord(
      root,
      'mind/proposals/shared/knowledge/k-prop.md',
      k('k-prop', { status: 'proposal' }),
      body,
    )
    await putRecord(
      root,
      'mind/shared/knowledge/k-draft.md',
      k('k-draft', { status: 'proposal' }),
      body,
    )
    await putRecord(
      root,
      'mind/shared/knowledge/k-old.md',
      k('k-old', { status: 'outdated' }),
      body,
    )
    await putRecord(
      root,
      'mind/shared/knowledge/k-expired.md',
      k('k-expired', { valid_to: '2020-12-31' }),
      body,
    )
    await putRecord(
      root,
      'mind/shared/knowledge/k-future.md',
      k('k-future', { valid_from: '2099-01-01' }),
      body,
    )
    expect((await ensureMindIndex(db, root)).records).toBe(1)
    const hits = await mind.search({
      text: 'гарантия',
      scope: DIR,
      types: ['knowledge'],
      limit: 10,
    })
    expect(hits.map((h) => h.id)).toEqual(['k-valid'])
    const ids = ['k-prop', 'k-draft', 'k-old', 'k-expired', 'k-future', 'k-valid']
    expect((await mind.byIds(ids)).map((h) => h.id)).toEqual(['k-valid'])
  })

  it('FR-MIND-1: a direction record is found only for its account', async () => {
    const root = await priceMind()
    await putRecord(
      root,
      `mind/directions/${DIR}/knowledge/k-clinic.md`,
      { id: 'k-clinic', type: 'knowledge', scope: DIR, title: 'Сайты для клиник' },
      'Делали сайт для клиники.',
    )
    await ensureMindIndex(db, root)
    const q = { text: 'сайт для клиники', types: ['knowledge' as const], limit: 5 }
    const own = await mind.search({ ...q, scope: DIR })
    expect(own.map((h) => h.id).sort()).toEqual(['k-clinic', 'k-price'])
    expect(own.find((h) => h.id === 'k-clinic')?.scope).toBe(DIR)
    const other = await mind.search({ ...q, scope: 'hance-design' })
    expect(other.map((h) => h.id)).toEqual(['k-price'])
  })

  it('FR-SPEECH-2: examples are searched by what the client wrote', async () => {
    const root = await tempMind()
    await putRecord(
      root,
      'mind/shared/speech/examples/e-landing.md',
      { id: 'e-landing', type: 'example', tones: ['hurry'], stages: ['talking'] },
      '## Клиент\nСколько будет стоить лендинг?\n\n## Борис\nДавайте созвонимся, обсудим задачу.',
    )
    await putRecord(
      root,
      'mind/shared/speech/examples/e-cases.md',
      { id: 'e-cases', type: 'example' },
      '## Клиент\nЕсть ли у вас кейсы?\n\n## Борис\nДа, покажу на созвоне лендинг для клиники.',
    )
    await ensureMindIndex(db, root)
    const hits = await mind.search({
      text: 'а лендинг сколько стоит',
      scope: DIR,
      types: ['example'],
      limit: 5,
      field: 'example_client',
    })
    expect(hits.map((h) => h.id)).toEqual(['e-landing'])
    expect(hits[0]).toMatchObject({
      exampleClient: 'Сколько будет стоить лендинг?',
      exampleBoris: 'Давайте созвонимся, обсудим задачу.',
      tones: ['hurry'],
      stages: ['talking'],
    })
    const byBody = await mind.search({ text: 'лендинг', scope: DIR, types: ['example'], limit: 5 })
    expect(byBody.map((h) => h.id).sort()).toEqual(['e-cases', 'e-landing'])
  })

  it('FR-MIND-2: ensureMindIndex with the same version again changes nothing', async () => {
    const root = await priceMind()
    const first = await ensureMindIndex(db, root)
    expect(first).toEqual({
      mindVersion: expect.stringMatching(/^[0-9a-f]{12}$/),
      records: 2,
      changed: true,
    })
    expect(await mind.version()).toBe(first.mindVersion)
    expect(await ensureMindIndex(db, root)).toEqual({ ...first, changed: false })
    expect(await countEvents(db, 'mind.indexed')).toBe(1)

    await putRecord(
      root,
      'mind/shared/knowledge/k-timeline.md',
      { id: 'k-timeline', type: 'knowledge', status: 'outdated' },
      'Устарело.',
    )
    const next = await ensureMindIndex(db, root)
    expect(next).toMatchObject({ records: 1, changed: true })
    expect(next.mindVersion).not.toBe(first.mindVersion)
    expect(await mind.version()).toBe(next.mindVersion)
    expect(await countEvents(db, 'mind.indexed')).toBe(2)
  })

  it('FR-MIND-3: a record comes into force on its Moscow day without a new mind version', async () => {
    const root = await priceMind()
    await putRecord(
      root,
      'mind/shared/knowledge/k-november.md',
      { id: 'k-november', type: 'knowledge', valid_from: '2026-11-01' },
      'Новая цена с ноября.',
    )
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-31T20:00:00Z'))
      const before = await ensureMindIndex(db, root)
      expect(before).toMatchObject({ records: 2, changed: true })
      expect(await ensureMindIndex(db, root)).toMatchObject({ records: 2, changed: false })
      vi.setSystemTime(new Date('2026-10-31T21:30:00Z'))
      expect(await ensureMindIndex(db, root)).toEqual({ ...before, records: 3, changed: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('FR-MIND-1: the empty mind has the version empty', async () => {
    const root = await tempMind()
    expect(await ensureMindIndex(db, `${root}/missing`)).toEqual({
      mindVersion: 'empty',
      records: 0,
      changed: true,
    })
    expect(await mind.version()).toBe('empty')
  })

  it('FR-MIND-2: byIds keeps the asked order and byStage prefers the direction', async () => {
    const root = await priceMind()
    await putRecord(
      root,
      'mind/shared/judgment/stages/j-stage-bid-sent.md',
      { id: 'j-stage-bid-sent', type: 'judgment', stages: ['bid_sent'] },
      'Общая процедура.',
    )
    await putRecord(
      root,
      `mind/directions/${DIR}/judgment/j-stage-bid-sent-dir.md`,
      { id: 'j-stage-bid-sent-dir', type: 'judgment', scope: DIR, stages: ['bid_sent', 'talking'] },
      'Процедура направления.',
    )
    await ensureMindIndex(db, root)
    expect((await mind.byIds(['k-timeline', 'nope', 'k-price'])).map((h) => h.id)).toEqual([
      'k-timeline',
      'k-price',
    ])
    expect((await mind.byStage('bid_sent', DIR))?.id).toBe('j-stage-bid-sent-dir')
    expect((await mind.byStage('bid_sent', 'hance-design'))?.id).toBe('j-stage-bid-sent')
    expect(await mind.byStage('call_done', DIR)).toBeNull()
  })

  it('FR-CONV-4: the banned phrases come from the speech portrait', async () => {
    const root = await tempMind()
    await putRecord(
      root,
      'mind/shared/speech/portrait.md',
      { id: 's-portrait', type: 'speech' },
      '## Форма\n- Коротко.\n\n## Никогда не говорит\n- «Отличный вопрос!»\n- Рад помочь\nне пункт\n\n## Темп\n- Без спешки.',
    )
    expect(await mind.bannedPhrases()).toEqual([])
    await ensureMindIndex(db, root)
    expect(await mind.bannedPhrases()).toEqual(['Отличный вопрос!', 'Рад помочь'])
  })
})
