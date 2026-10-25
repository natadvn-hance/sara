import { describe, expect, it } from 'vitest'
import { guardRecord } from '../../src/mind/guard'
import { renderRecord } from '../../src/mind/render'
import { exampleChange, knowledgeChange } from '../../src/school/lessons/records'
import type { GuardInput, LessonRow, MindChange } from '../../src/school/types'

const TODAY = '2026-10-26'
const lessonRow = (o: Partial<LessonRow> = {}): LessonRow => ({
  id: 'l1',
  n: 7,
  source: 'edit',
  sourceRef: 't1',
  scope: 'shared',
  topic: 'price',
  tone: 'doubt',
  questionType: null,
  clientText: null,
  before: null,
  after: 'Сайт от 80 000, сроки скажу после созвона',
  insight: '',
  kind: 'voice',
  state: 'yes',
  inPlace: false,
  sim: false,
  attempts: 0,
  batchId: null,
  taskId: null,
  reason: null,
  modelCallId: null,
  commitId: null,
  createdAt: TODAY,
  decidedAt: TODAY,
  ...o,
})
const example = (o: Partial<MindChange> = {}): MindChange => ({
  ...exampleChange({
    scope: 'shared',
    topic: 'price',
    tone: 'doubt',
    stage: null,
    clientText: 'Сколько стоит?',
    borisText: 'Цену скажу после созвона',
    insight: 'Цену не называть до созвона',
    source: 'edit:conv-turn:1',
    names: [],
  }),
  recordId: 'e-l-7',
  ...o,
})
const check = (c: MindChange, o: Partial<GuardInput> = {}) =>
  guardRecord({
    change: c,
    text: renderRecord(c, null, TODAY).text,
    lesson: lessonRow(),
    sourceLessons: [],
    existingIds: new Set(),
    clientNames: ['Анна'],
    scopes: ['shared', 'hance-marketing'],
    ...o,
  })

describe('the mind guard', () => {
  it('FR-MIND-3: a good example passes', () => {
    expect(check(example())).toBeNull()
  })

  it('FR-TRAIN-9: a record with a sim source is refused', () => {
    expect(check(example({ sources: ['sim:d1:2'] }))).toMatch(/сгенерированного/)
    expect(check(example(), { lesson: lessonRow({ sim: true }) })).toMatch(/сгенерированной/)
  })

  it("FR-MIND-3: an example without Boris's words is refused", () => {
    expect(check(example({ sources: ['teacher:run-1'] }))).toMatch(/слов Бориса/)
  })

  it('FR-MIND-3: a price that Boris never said is refused', () => {
    const c: MindChange = {
      ...knowledgeChange({
        scope: 'shared',
        topic: 'price',
        fact: { title: 'Цена сайта', fact: 'Сайт от 120 000', when: 'после созвона', not_say: '' },
        source: 'lesson:3',
        names: [],
      }),
      recordId: 'k-site-price',
    }
    const teacher = lessonRow({ source: 'teacher', kind: 'fact' })
    expect(check(c, { lesson: teacher, sourceLessons: [lessonRow()] })).toMatch(/120000/)
    const said = { ...c, sections: { ...c.sections, Факт: 'Сайт от 80 000' } }
    expect(check(said, { lesson: teacher, sourceLessons: [lessonRow()] })).toBeNull()
  })

  it('FR-MIND-3: a record id «../x» or a foreign scope never becomes a path', () => {
    expect(check(example({ recordId: '../x' }))).toMatch(/номер записи/)
    expect(check(example({ recordId: 'k-x' }))).toMatch(/не той буквы/)
    expect(check(example({ scope: 'other-account' }))).toMatch(/чужая область/)
  })

  it('FR-MIND-3: a section that does not belong to the type is refused', () => {
    expect(check(example({ sections: { Клиент: 'а', Секрет: 'б' } }))).toMatch(/лишний раздел/)
  })

  it('FR-MIND-3: a second record with the same id is refused', () => {
    expect(check(example(), { existingIds: new Set(['e-l-7']) })).toMatch(/уже есть/)
  })

  it("NFR-PRIV-2: a record with a phone, a link or the client's name is refused", () => {
    const c = example({
      sections: { Клиент: 'Звоните +7 999 123-45-67', Борис: 'ок', Контекст: '' },
    })
    expect(check(c)).toMatch(/телефон/)
    const named = example({ sections: { Клиент: 'Анна спросила', Борис: 'ок', Контекст: '' } })
    expect(check(named)).toMatch(/имя клиента/)
    const link = example({ sections: { Клиент: 'см. https://x.ru', Борис: 'ок', Контекст: '' } })
    expect(check(link)).toMatch(/ссылка/)
  })

  it('FR-MIND-3: a record whose lesson Boris did not say yes to is refused', () => {
    const c: MindChange = {
      ...knowledgeChange({
        scope: 'shared',
        topic: 'process',
        fact: { title: 'Порядок', fact: 'Сначала созвон', when: '', not_say: '' },
        source: 'interview:3',
        names: [],
      }),
      recordId: 'k-i-3',
    }
    expect(check(c, { lesson: lessonRow({ state: 'no' }) })).toMatch(/«да»/)
  })
})
