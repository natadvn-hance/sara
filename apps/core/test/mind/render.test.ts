import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkMind } from '../../../../scripts/mind-check'
import { confirmContent, renderRecord, splitRecord } from '../../src/mind/render'
import { exampleChange } from '../../src/school/lessons/records'
import type { MindChange } from '../../src/school/types'

const TODAY = '2026-10-26'
const example = (): MindChange => ({
  ...exampleChange({
    scope: 'shared',
    topic: 'price',
    tone: 'doubt',
    stage: 'talking',
    clientText: 'Сколько стоит?',
    borisText: 'Цену скажу после созвона',
    insight: 'Цену не называть до созвона',
    source: 'edit:conv-turn:1',
    names: [],
  }),
  recordId: 'e-l-7',
})

const portrait = `---
id: "s-portrait"
type: "speech"
scope: "shared"
status: "confirmed"
version: 2
sources: ["boris:2026-10-22"]
valid_from: "2026-10-22"
valid_to: null
title: "Портрет речи"
---

## Форма
Коротко

## Словарь
Простые слова
`

describe('building a mind record', () => {
  it('FR-MIND-3: a new example is version 1, confirmed, under speech/examples, and passes mind:check', async () => {
    const r = renderRecord(example(), null, TODAY)
    expect(r.target).toBe('mind/shared/speech/examples/e-l-7.md')
    const { front, sections } = splitRecord(r.text)
    expect(front).toMatchObject({
      id: 'e-l-7',
      type: 'example',
      status: 'confirmed',
      version: 1,
      valid_from: TODAY,
      valid_to: null,
      topic: 'price',
      tones: ['doubt'],
      sources: ['edit:conv-turn:1'],
    })
    expect(sections.map(([h]) => h)).toEqual(['Клиент', 'Борис', 'Контекст'])
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    await mkdir(dirname(join(dir, r.target)), { recursive: true })
    await writeFile(join(dir, r.target), r.text)
    expect(await checkMind(join(dir, 'mind'))).toEqual([])
  })

  it('FR-SPEECH-1: an update of one section changes only that section and the version', () => {
    const c: MindChange = {
      ...example(),
      action: 'update',
      recordId: 's-portrait',
      type: 'speech',
      section: 'Форма',
      sections: { Форма: 'Одна-две фразы [e-l-7]' },
      sources: ['lesson:12'],
      fields: {},
    }
    const r = renderRecord(
      c,
      { version: 2, text: portrait, status: 'confirmed', path: 'mind/shared/speech/portrait.md' },
      TODAY,
    )
    expect(r.target).toBe('mind/shared/speech/portrait.md')
    const { front, sections } = splitRecord(r.text)
    expect(front).toMatchObject({ version: 3, title: 'Портрет речи' })
    expect(front.sources).toEqual(['boris:2026-10-22', 'lesson:12'])
    expect(sections).toEqual([
      ['Форма', 'Одна-две фразы [e-l-7]'],
      ['Словарь', 'Простые слова'],
    ])
  })

  it('FR-SPEECH-1: the first accepted section of a portrait that is only a proposal starts a confirmed one', () => {
    const c: MindChange = {
      ...example(),
      action: 'update',
      recordId: 's-portrait',
      type: 'speech',
      section: 'Темп',
      sections: { Темп: 'Отвечает за 10 минут [e-l-7]' },
      fields: { title: 'Портрет речи' },
    }
    const r = renderRecord(c, { version: 1, text: portrait, status: 'proposal' }, TODAY)
    expect(r.target).toBe('mind/shared/speech/s-portrait.md')
    expect(splitRecord(r.text).sections).toEqual([['Темп', 'Отвечает за 10 минут [e-l-7]']])
    expect(splitRecord(r.text).front).toMatchObject({ version: 1, status: 'confirmed' })
  })

  it('FR-MIND-3: an outdated record keeps its file and leaves the index', () => {
    const c: MindChange = {
      ...example(),
      action: 'outdate',
      recordId: 's-portrait',
      type: 'speech',
    }
    const r = renderRecord(
      c,
      { version: 2, text: portrait, status: 'confirmed', path: 'mind/shared/speech/portrait.md' },
      TODAY,
    )
    expect(splitRecord(r.text).front).toMatchObject({
      status: 'outdated',
      valid_to: TODAY,
      version: 3,
    })
    expect(splitRecord(r.text).sections).toHaveLength(2)
  })

  it('FR-MIND-3: an M4 proposal file becomes confirmed as it is', () => {
    const text = confirmContent(portrait.replace('"confirmed"', '"proposal"'), TODAY)
    expect(splitRecord(text).front).toMatchObject({ status: 'confirmed', version: 2 })
  })
})
