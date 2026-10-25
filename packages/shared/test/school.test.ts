import { describe, expect, it } from 'vitest'
import { EVENT_TYPES } from '../src/contracts/eventTypes'
import {
  CoachOutput,
  GeneratorOutput,
  LESSON_SOURCES,
  LessonMakerOutput,
  MIND_RECORD_ID,
  MODEL_UNITS,
  Persona,
  PersonaOutput,
  parseCallback,
  SETTINGS,
  TeacherOutput,
  TeacherProposal,
  TrainerClientOutput,
} from '../src/index'

const proposal = {
  action: 'create',
  record_id: 'u-timeline-hurry',
  type: 'understanding',
  scope: 'shared',
  title: 'Клиент торопит со сроками',
  topic: 'timeline',
  section: null,
  sections: { Признаки: 'Клиент просит начать завтра', 'Как отвечает Борис': 'Зовёт на созвон' },
  sources: ['lesson:12', 'e-l-12'],
  lesson_ids: ['0199d0b0-0000-7000-8000-000000000012'],
  why: 'Борис дважды не назвал срок в переписке',
}

const persona = {
  archetype: 'Владелец кофейни',
  niche: 'общепит',
  task: 'реклама в соцсетях',
  mood: 'hurry',
  style: 'коротко, без знаков, на «вы»',
  questions: ['Сколько стоит?'],
  topics: ['price', 'timeline'],
  order: { title: 'SMM для кофейни', text: 'Нужно вести инстаграм', budget_text: 'до 30 000 ₽' },
  difficulty: 2,
  hard: false,
  from: [1, 4],
}

describe('M5 contracts', () => {
  it('FR-TRAIN-3: the trainer client says a line, may end the dialog and has a mood', () => {
    expect(TrainerClientOutput.parse({ text: 'А сроки?', ends: 'no', mood: 'hurry' }).ends).toBe(
      'no',
    )
    expect(TrainerClientOutput.safeParse({ text: '', ends: 'no', mood: 'hurry' }).success).toBe(
      false,
    )
    expect(
      TrainerClientOutput.safeParse({ text: 'x'.repeat(801), ends: 'left', mood: 'neutral' })
        .success,
    ).toBe(false)
  })

  it('FR-TRAIN-4: the coach answers and may give an insight', () => {
    expect(
      CoachOutput.parse({ answer: 'Опиралась на образец', insight: null, kind: null }).answer,
    ).toBe('Опиралась на образец')
    expect(CoachOutput.safeParse({ answer: 'x', insight: 'y', kind: 'bulk' }).success).toBe(false)
    expect(CoachOutput.safeParse({ answer: 'x', insight: 'y', kind: null }).success).toBe(false)
  })

  it('FR-TRAIN-6: the lesson maker gives one insight, a topic, a tone and maybe a fact', () => {
    const ok = {
      worth: true,
      insight: 'Срок не обещать в переписке',
      kind: 'procedure',
      topic: 'timeline',
      tone: 'hurry',
      fact: null,
    }
    expect(LessonMakerOutput.parse(ok).worth).toBe(true)
    expect(LessonMakerOutput.safeParse({ ...ok, insight: 'x'.repeat(241) }).success).toBe(false)
    expect(
      LessonMakerOutput.parse({
        ...ok,
        kind: 'fact',
        fact: { title: 'Цена сайта', fact: 'от 80 000 ₽', when: 'после созвона', not_say: '' },
      }).fact?.title,
    ).toBe('Цена сайта')
  })

  it('FR-TRAIN-7: a teacher proposal without sources or with record id «../x» is refused', () => {
    expect(TeacherProposal.parse(proposal).record_id).toBe('u-timeline-hurry')
    expect(TeacherProposal.safeParse({ ...proposal, sources: [] }).success).toBe(false)
    expect(TeacherProposal.safeParse({ ...proposal, record_id: '../x' }).success).toBe(false)
    expect(TeacherProposal.safeParse({ ...proposal, record_id: 'u-A' }).success).toBe(false)
    expect(TeacherProposal.safeParse({ ...proposal, record_id: 'k-timeline' }).success).toBe(false)
    expect(MIND_RECORD_ID.test('k-i-17')).toBe(true)
    expect(MIND_RECORD_ID.test('x-golden-1')).toBe(false)
  })

  it('FR-TRAIN-7: the teacher gives at most 8 proposals and 3 questions', () => {
    expect(TeacherOutput.parse({ proposals: [proposal], questions: [] }).proposals).toHaveLength(1)
    expect(
      TeacherOutput.safeParse({ proposals: Array(9).fill(proposal), questions: [] }).success,
    ).toBe(false)
    expect(
      TeacherOutput.safeParse({ proposals: [], questions: ['a', 'b', 'c', 'd'] }).success,
    ).toBe(false)
  })

  it('FR-TRAIN-2: a persona built from one client is refused', () => {
    expect(PersonaOutput.parse({ personas: [persona] }).personas).toHaveLength(1)
    expect(PersonaOutput.safeParse({ personas: [{ ...persona, from: [3] }] }).success).toBe(false)
  })

  it('FR-TRAIN-2: a stored persona names its sources', () => {
    const { from: _from, ...rest } = persona
    const stored = { ...rest, id: 'p-coffee', source_refs: ['chat:95147898'], handmade: false }
    expect(Persona.parse(stored).id).toBe('p-coffee')
    expect(Persona.safeParse({ ...stored, source_refs: [] }).success).toBe(false)
  })

  it('FR-TRAIN-9: a generated client line without a topic is refused', () => {
    const dialog = {
      persona_id: 'p-coffee',
      messages: [
        { side: 'client', text: 'Здравствуйте', topic: 'smalltalk' },
        { side: 'specialist', text: 'Добрый день' },
        { side: 'client', text: 'Сколько стоит?', topic: 'price' },
        { side: 'specialist', text: 'Давайте созвонимся' },
      ],
    }
    expect(GeneratorOutput.parse({ dialogs: [dialog] }).dialogs).toHaveLength(1)
    const noTopic = {
      ...dialog,
      messages: [{ side: 'client', text: 'Привет' }, ...dialog.messages.slice(1)],
    }
    expect(GeneratorOutput.safeParse({ dialogs: [noTopic] }).success).toBe(false)
    expect(GeneratorOutput.safeParse({ dialogs: Array(6).fill(dialog) }).success).toBe(false)
  })

  it('FR-TRAIN-6: lesson sources include the ones from work, the trainer and the starting mind', () => {
    expect(LESSON_SOURCES).toEqual([
      'edit',
      'say',
      'compare',
      'training',
      'interview',
      'teacher',
      'review',
      'history',
      'import',
    ])
  })

  it('NFR-COST-2: model units weigh opus over sonnet over haiku', () => {
    expect(MODEL_UNITS).toEqual({ haiku: 1, sonnet: 4, opus: 20 })
  })

  it('FR-AUTO-3: school and autonomy settings have the defaults of the design', () => {
    const defaults = Object.fromEntries(
      Object.entries(SETTINGS)
        .filter(([k]) => k.startsWith('school.') || k.startsWith('auto.'))
        .map(([k, v]) => [k, v.default]),
    )
    expect(defaults).toEqual({
      'school.on': false,
      'school.night': { from: 1, to: 7 },
      'school.night_units': 400,
      'school.weekly_units': 700,
      'school.weekly_day': 0,
      'school.generator_dialogs': 50,
      'school.lesson_batch': 5,
      'school.batches_per_day': 2,
      'school.cards_waiting_max': 15,
      'school.messages_per_day': 3,
      'school.judge_trusted': false,
      'auto.approvals_to_promote': 10,
      'auto.trainer_checks': 5,
      'auto.trainer_good': 4,
      'auto.substantial_below': 70,
      'auto.from_understanding': true,
    })
    expect(SETTINGS['school.weekly_day'].schema.safeParse(7).success).toBe(false)
    expect(SETTINGS['school.night'].schema.safeParse({ from: 3, to: 3 }).success).toBe(false)
    expect(SETTINGS['auto.substantial_below'].schema.safeParse(101).success).toBe(false)
  })

  it('FR-TRAIN-6: every M5 event is listed once', () => {
    const m5 = [
      'lesson.created',
      'lesson.batch_sent',
      'lesson.decided',
      'mind.written',
      'mind.reverted',
      'mind.synced',
      'mind.sync_failed',
      'school.night_ran',
      'school.night_skipped',
      'teacher.proposed',
      'persona.built',
      'training.started',
      'training.answered',
      'training.finished',
      'sim.generated',
      'interview.answered',
      'blind.ready',
      'blind.finished',
      'autonomy.proposed',
      'autonomy.changed',
      'exam.judge_trusted',
      'exam.golden_worse',
    ]
    for (const t of m5) expect(EVENT_TYPES.filter((e) => e === t)).toHaveLength(1)
  })

  it('FR-TRAIN-6: «Все да» is a button of its own', () => {
    expect(parseCallback('t:abc:all')).toEqual({ taskId: 'abc', action: 'all' })
  })
})
