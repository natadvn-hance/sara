import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMind } from '../../src/mind/loader'
import { gitCommitAll, putFile, putRecord, tempMind } from '../helpers/mind'

const PRICE = 'mind/shared/knowledge/k-price.md'

describe('mind loader', () => {
  it('FR-MIND-3: proposals are never loaded', async () => {
    const root = await tempMind()
    await putRecord(root, PRICE, { id: 'k-price', type: 'knowledge' }, '## Факт\nЦена по запросу.')
    await putRecord(
      root,
      'mind/proposals/shared/knowledge/k-new.md',
      { id: 'k-new', type: 'knowledge', status: 'proposal' },
      '## Факт\nЧерновик.',
    )
    await putFile(root, 'exam/scenarios/x-1.json', '{}')
    const m = await loadMind(root)
    expect(m.records.map((r) => r.front.id)).toEqual(['k-price'])
    expect(m.errors).toEqual([])
  })

  it('FR-MIND-1: the mind version changes when a confirmed file changes', async () => {
    const root = await tempMind()
    await putRecord(root, PRICE, { id: 'k-price', type: 'knowledge' }, '## Факт\nЦена по запросу.')
    await putRecord(
      root,
      'mind/proposals/shared/knowledge/k-new.md',
      { id: 'k-new', type: 'knowledge', status: 'proposal' },
      'Черновик.',
    )
    const first = (await loadMind(root)).mindVersion
    expect(first).toMatch(/^[0-9a-f]{12}$/)
    expect((await loadMind(root)).mindVersion).toBe(first)

    await putFile(root, 'mind/proposals/shared/knowledge/k-new.md', 'другой черновик')
    expect((await loadMind(root)).mindVersion).toBe(first)

    await putRecord(root, PRICE, { id: 'k-price', type: 'knowledge' }, '## Факт\nЦена от 50.')
    expect((await loadMind(root)).mindVersion).not.toBe(first)
  })

  it('FR-MIND-1: in a git clone the mind version is its commit', async () => {
    const root = await tempMind()
    await putRecord(root, PRICE, { id: 'k-price', type: 'knowledge' }, '## Факт\nЦена по запросу.')
    const head = await gitCommitAll(root)
    expect((await loadMind(root)).mindVersion).toBe(head)
  })

  it('FR-MIND-1: a record with a wrong field is reported with its path and field, the others load', async () => {
    const root = await tempMind()
    await putRecord(root, PRICE, { id: 'k-price', type: 'knowledge' }, 'Цена по запросу.')
    await putRecord(
      root,
      'mind/shared/knowledge/k-bad.md',
      { id: 'k-bad', type: 'knowledge', status: 'maybe' },
      'Неверный статус.',
    )
    await putFile(root, 'mind/shared/knowledge/k-plain.md', 'Просто текст без полей.\n')
    const m = await loadMind(root)
    expect(m.records.map((r) => r.front.id)).toEqual(['k-price'])
    expect(m.errors).toEqual([
      { path: 'mind/shared/knowledge/k-bad.md', message: expect.stringMatching(/status/) },
      { path: 'mind/shared/knowledge/k-plain.md', message: expect.stringMatching(/---/) },
    ])
  })

  it('FR-MIND-1: the title comes from the field or the first heading, sections from second-level headings', async () => {
    const root = await tempMind()
    await putRecord(
      root,
      'mind/shared/speech/examples/e-landing.md',
      { id: 'e-landing', type: 'example' },
      '# Цена лендинга\n\n## Клиент\nСколько стоит лендинг?\n\n## Борис\nДавайте созвонимся, расскажу.',
    )
    await putRecord(
      root,
      PRICE,
      { id: 'k-price', type: 'knowledge', title: 'Стоимость сайтов' },
      '# Другое\n\n## Факт\nЦена по запросу.',
    )
    await putRecord(
      root,
      'mind/shared/judgment/j-plain.md',
      { id: 'j-plain', type: 'judgment' },
      'Без заголовка.',
    )
    const m = await loadMind(root)
    const byId = Object.fromEntries(m.records.map((r) => [r.front.id, r]))
    expect(byId['e-landing']).toMatchObject({
      path: 'mind/shared/speech/examples/e-landing.md',
      title: 'Цена лендинга',
      sections: { Клиент: 'Сколько стоит лендинг?', Борис: 'Давайте созвонимся, расскажу.' },
    })
    expect(byId['e-landing']?.body).not.toMatch(/^# /)
    expect(byId['e-landing']?.body).toMatch(/## Клиент/)
    expect(byId['k-price']?.title).toBe('Стоимость сайтов')
    expect(byId['j-plain']?.title).toBe('j-plain')
  })

  it('FR-MIND-1: a repeated id or a scope unlike its folder is an error', async () => {
    const root = await tempMind()
    await putRecord(root, 'mind/shared/knowledge/k-a.md', { id: 'k-a', type: 'knowledge' }, 'Один.')
    await putRecord(root, 'mind/shared/knowledge/k-b.md', { id: 'k-a', type: 'knowledge' }, 'Два.')
    await putRecord(
      root,
      'mind/directions/hance-marketing/knowledge/k-dir.md',
      { id: 'k-dir', type: 'knowledge', scope: 'shared' },
      'Не та область.',
    )
    await putRecord(
      root,
      'mind/directions/hance-marketing/knowledge/k-own.md',
      { id: 'k-own', type: 'knowledge', scope: 'hance-marketing' },
      'Своя область.',
    )
    const m = await loadMind(root)
    expect(m.records.map((r) => r.front.id).sort()).toEqual(['k-a', 'k-own'])
    expect(m.records.find((r) => r.front.id === 'k-a')?.path).toBe('mind/shared/knowledge/k-a.md')
    expect(m.errors).toEqual([
      {
        path: 'mind/directions/hance-marketing/knowledge/k-dir.md',
        message: expect.stringMatching(/scope/),
      },
      { path: 'mind/shared/knowledge/k-b.md', message: expect.stringMatching(/k-a/) },
    ])
  })

  it('FR-MIND-1: no folder is an empty mind', async () => {
    const root = await tempMind()
    expect(await loadMind(join(root, 'missing'))).toEqual({
      records: [],
      mindVersion: 'empty',
      errors: [],
    })
  })
})
