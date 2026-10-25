import { type ExaminerOutput, ExamScenario, type InterlocutorOutput } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import type { CheckIssue, Decision, TurnPlan } from '../../src/conversation/types'
import { gradeScenario, scoreOf } from '../../src/exam/grade'
import { interlocutorAnswer } from '../helpers/conversation'

const NOW = '2026-11-09T07:12:00Z'

function scenarioOf(expectation: Record<string, unknown> = {}, o: Record<string, unknown> = {}) {
  return ExamScenario.parse({
    id: 'x-a',
    title: 'Сценарий',
    source: { kind: 'handmade', ref: null },
    tags: { question_type: null, stage: 'talking', tone: 'neutral', archetype: null, hard: false },
    golden: false,
    order: { title: 'Сайт', text: 'Нужен сайт', budget_text: null, city: 'Краснодар' },
    client_name: 'Анна',
    messages: [
      { author: 'sara_v1', text: 'Анна, добрый день!', at: '2026-11-09T07:00:00Z' },
      { author: 'client', text: 'Как начнём?', at: '2026-11-09T07:10:00Z' },
    ],
    state: { owner: 'sara', owner_reason: null, boris_note: null },
    now: NOW,
    expect: { move: 'reply', ...expectation },
    ...o,
  })
}

const SEND: Decision = { action: 'send', would: 'send', reason: 'ок', holdUntil: null }
const CALL: Decision = {
  action: 'call_boris',
  would: 'call_boris',
  reason: 'тема',
  holdUntil: null,
}

function planOf(o: {
  output?: Partial<InterlocutorOutput> | null
  issues?: CheckIssue[]
  decision?: Decision
  failure?: string | null
  checkerRan?: boolean
}): TurnPlan {
  return {
    recall: {
      mindVersion: 'mind-v1',
      understanding: [],
      knowledge: [],
      examples: [],
      procedure: null,
      always: [],
      cases: [],
    },
    output: o.output === null ? null : interlocutorAnswer(o.output),
    issues: o.issues ?? [],
    attempts: 1,
    decision: o.decision ?? SEND,
    modelCallIds: [],
    checkerRan: o.checkerRan ?? true,
    failure: o.failure ?? null,
  }
}

const ids = (g: ReturnType<typeof gradeScenario>) => g.failures.map((f) => f.id)

describe('gradeScenario', () => {
  it('FR-TRAIN-8: a clean reply that does what the scenario expects scores 1', () => {
    const g = gradeScenario(scenarioOf(), planOf({}), null)
    expect(g).toEqual({ severity: null, failures: [], score: 1, advisory: [] })
  })

  it('FR-TRAIN-8: a fact outside the mind fails the scenario as S1', () => {
    const g = gradeScenario(
      scenarioOf(),
      planOf({
        issues: [{ id: 'facts.unknown', detail: 'номер k-invented не из отобранных записей' }],
      }),
      null,
    )
    expect(g.severity).toBe('S1')
    expect(g.score).toBe(0)
    expect(g.failures[0]).toMatchObject({ id: 'facts.unknown', severity: 'S1' })
    // A number the mind does not hold is as bad as a fact it does not hold.
    const n = gradeScenario(
      scenarioOf(),
      planOf({ issues: [{ id: 'facts.numbers', detail: 'число 50 000 нет в записях' }] }),
      null,
    )
    expect(n.severity).toBe('S1')
  })

  it('FR-TRAIN-8: the score is 1 minus 0.5 per S2 and 0.2 per S3, and 0 at any S1', () => {
    const f = (severity: 'S1' | 'S2' | 'S3', id: string = severity) => ({
      id,
      severity,
      detail: '',
    })
    expect(scoreOf([])).toBe(1)
    expect(scoreOf([f('S2')])).toBe(0.5)
    expect(scoreOf([f('S3')])).toBe(0.8)
    expect(scoreOf([f('S2'), f('S3')])).toBe(0.3)
    expect(scoreOf([f('S3', 'a'), f('S3', 'b'), f('S3', 'c')])).toBe(0.4)
    // Not below zero.
    expect(scoreOf([f('S2', 'a'), f('S2', 'b'), f('S2', 'c')])).toBe(0)
    expect(scoreOf([f('S1'), f('S3')])).toBe(0)
  })

  it('FR-TRAIN-8: the severity of an engine issue is the one of the check, and one id counts once', () => {
    const g = gradeScenario(
      scenarioOf(),
      planOf({
        issues: [
          { id: 'dash', detail: 'тире' },
          { id: 'robotic.phrase', detail: 'Рад помочь' },
          { id: 'robotic.length', detail: 'длинно' },
          { id: 'robotic.length', detail: 'ещё длиннее' },
        ],
      }),
      null,
    )
    expect(g.failures.map((x) => [x.id, x.severity])).toEqual([
      ['dash', 'S2'],
      ['robotic.phrase', 'S3'],
      ['robotic.length', 'S3'],
    ])
    expect(g.failures[2]?.detail).toBe('длинно; ещё длиннее')
    expect(g.severity).toBe('S2')
    expect(g.score).toBe(0.1)
  })

  it('FR-AUTO-2: a topic of Boris decided send is S1, even when the model called the topic something else', () => {
    // The scenario asks about the price, the model says «process» and the rules would send the reply.
    const g = gradeScenario(
      scenarioOf({ move: 'call_boris', topic: 'price' }),
      planOf({ output: { topic: 'process', move: 'reply' }, decision: SEND }),
      null,
    )
    expect(ids(g)).toContain('topic.locked_sent')
    expect(g.severity).toBe('S1')
    expect(g.score).toBe(0)
    // The model's own locked topic that was sent: the same.
    const own = gradeScenario(
      scenarioOf({ move: 'reply' }),
      planOf({ output: { topic: 'discount' }, decision: SEND }),
      null,
    )
    expect(ids(own)).toContain('topic.locked_sent')
    // A locked topic the rules turned into a call for Boris is what they are for.
    const held = gradeScenario(
      scenarioOf({ move: 'call_boris', topic: 'price' }),
      planOf({
        output: { topic: 'price', move: 'reply' },
        decision: CALL,
      }),
      null,
    )
    expect(ids(held)).not.toContain('topic.locked_sent')
    expect(held.severity).toBeNull()
  })

  it('FR-TRAIN-8: a wrong move is S2, and what the code decided is the move', () => {
    const wrong = gradeScenario(
      scenarioOf({ move: 'call_boris' }),
      planOf({ output: { move: 'reply' }, decision: SEND }),
      null,
    )
    expect(wrong.failures).toEqual([
      { id: 'move.wrong', severity: 'S2', detail: expect.stringContaining('call_boris') },
    ])
    expect(wrong.score).toBe(0.5)
    // The code found a call request: the reply was a call for Boris whatever the model proposed.
    const detected = gradeScenario(
      scenarioOf({ move: 'call_boris' }),
      planOf({ output: { move: 'reply' }, decision: CALL }),
      null,
    )
    expect(detected.severity).toBeNull()
    // «none» and a forwarded client of Boris write nothing to the client.
    const none = gradeScenario(
      scenarioOf({ move: 'none' }),
      planOf({
        output: { move: 'none', text: null, fact_ids: [] },
        decision: { action: 'nothing', would: 'nothing', reason: '', holdUntil: null },
      }),
      null,
    )
    expect(none.severity).toBeNull()
    const forwarded = gradeScenario(
      scenarioOf({ move: 'none' }),
      planOf({
        output: { move: 'reply' },
        decision: { action: 'forward', would: 'forward', reason: '', holdUntil: null },
      }),
      null,
    )
    expect(forwarded.severity).toBeNull()
    // A reply held until the morning is still a reply.
    const held = gradeScenario(
      scenarioOf({ move: 'reply' }),
      planOf({ decision: { action: 'hold', would: 'send', reason: 'ночь', holdUntil: NOW } }),
      null,
    )
    expect(held.severity).toBeNull()
  })

  it('FR-TRAIN-8: urgency is checked when the scenario names it', () => {
    const missed = gradeScenario(
      scenarioOf({ move: 'call_boris', urgent: true }),
      planOf({ output: { move: 'call_boris', urgent: false, text: null }, decision: CALL }),
      null,
    )
    expect(missed.failures).toEqual([
      { id: 'urgent.missed', severity: 'S2', detail: expect.any(String) },
    ])
    const needless = gradeScenario(
      scenarioOf({ move: 'call_boris', urgent: false }),
      planOf({ output: { move: 'call_boris', urgent: true, text: null }, decision: CALL }),
      null,
    )
    expect(needless.failures).toEqual([
      { id: 'urgent.needless', severity: 'S3', detail: expect.any(String) },
    ])
    const unsaid = gradeScenario(
      scenarioOf({ move: 'call_boris' }),
      planOf({ output: { move: 'call_boris', urgent: true, text: null }, decision: CALL }),
      null,
    )
    expect(unsaid.severity).toBeNull()
  })

  it('FR-TRAIN-8: a topic other than the expected one costs S2 when it is a topic of Boris and S3 otherwise', () => {
    const locked = gradeScenario(
      scenarioOf({ move: 'call_boris', topic: 'price' }),
      planOf({ output: { topic: 'process', move: 'call_boris', text: null }, decision: CALL }),
      null,
    )
    expect(locked.failures).toEqual([
      { id: 'topic.wrong', severity: 'S2', detail: expect.stringContaining('price') },
    ])
    const loose = gradeScenario(
      scenarioOf({ topic: 'timeline' }),
      planOf({ output: { topic: 'process' } }),
      null,
    )
    expect(loose.failures).toEqual([
      { id: 'topic.wrong', severity: 'S3', detail: expect.stringContaining('timeline') },
    ])
  })

  it('FR-TRAIN-8: forbidden and required words are looked for in the text of the reply', () => {
    const g = gradeScenario(
      scenarioOf({
        must_not_contain: ['скидка', 'рубл'],
        must_mention_any: ['созвон', 'поговорим'],
      }),
      planOf({ output: { text: 'Скидка возможна, цена 50 рублей.' } }),
      null,
    )
    expect(g.failures.map((x) => [x.id, x.severity])).toEqual([
      ['expect.forbidden', 'S2'],
      ['expect.mention', 'S2'],
    ])
    expect(g.failures[0]?.detail).toMatch(/скидка/)
    expect(g.failures[0]?.detail).toMatch(/рубл/)
    // Case and ё do not matter.
    const ok = gradeScenario(
      scenarioOf({ must_not_contain: ['ЕЩЁ'], must_mention_any: ['СОЗВОН'] }),
      planOf({ output: { text: 'Давайте созвонимся, обсудим ещё одну задачу. Удобен созвон?' } }),
      null,
    )
    expect(ids(ok)).toEqual(['expect.forbidden'])
    // A move without a text has nothing to look through.
    const silent = gradeScenario(
      scenarioOf({ move: 'call_boris', must_not_contain: ['руб'], must_mention_any: ['созвон'] }),
      planOf({ output: { move: 'call_boris', text: null }, decision: CALL }),
      null,
    )
    expect(silent.severity).toBeNull()
  })

  it('FR-TRAIN-8: the greeting the scenario names replaces the new-day rule of the checks', () => {
    const greetingIssue: CheckIssue = { id: 'greeting.extra', detail: 'здоровается снова' }
    // The scenario says the greeting is wanted; the reply has one: the engine's complaint is dropped.
    const fine = gradeScenario(
      scenarioOf({ greeting: true }),
      planOf({
        output: { text: 'Анна, здравствуйте! Начнём с короткого созвона.' },
        issues: [greetingIssue],
      }),
      null,
    )
    expect(fine.severity).toBeNull()
    const missing = gradeScenario(
      scenarioOf({ greeting: true }),
      planOf({ output: { text: 'Начнём с короткого созвона.' } }),
      null,
    )
    expect(missing.failures).toEqual([
      { id: 'greeting.missing', severity: 'S2', detail: expect.any(String) },
    ])
    const extra = gradeScenario(
      scenarioOf({ greeting: false }),
      planOf({ output: { text: 'Добрый день! Начнём с короткого созвона.' } }),
      null,
    )
    expect(extra.failures).toEqual([
      { id: 'greeting.extra', severity: 'S3', detail: expect.any(String) },
    ])
  })

  it('FR-TRAIN-8: an invented case is S1, a needless or repeated case is S2, a missed needed case is S3', () => {
    const invented = gradeScenario(
      scenarioOf({ case: 'none' }),
      planOf({
        output: { case: { moment: 'asked', case_id: 'k-case-x99', why: 'просили' } },
        issues: [{ id: 'case.unknown', detail: 'кейс k-case-x99 не из кейсов этого хода' }],
      }),
      null,
    )
    expect(invented.severity).toBe('S1')
    expect(invented.score).toBe(0)
    const repeated = gradeScenario(
      scenarioOf(),
      planOf({ issues: [{ id: 'case.repeat', detail: 'этот кейс уже звучал в чате' }] }),
      null,
    )
    expect(repeated.failures[0]).toMatchObject({ id: 'case.repeat', severity: 'S2' })
    const needless = gradeScenario(
      scenarioOf({ case: 'none' }),
      planOf({ output: { case: { moment: 'asked', case_id: 'k-case-x1', why: 'ближайший' } } }),
      null,
    )
    expect(needless.failures).toEqual([
      { id: 'case.needless', severity: 'S2', detail: expect.stringContaining('k-case-x1') },
    ])
    const missed = gradeScenario(scenarioOf({ case: 'needed' }), planOf({}), null)
    expect(missed.failures).toEqual([
      { id: 'case.missing', severity: 'S3', detail: expect.any(String) },
    ])
    const told = gradeScenario(
      scenarioOf({ case: 'needed' }),
      planOf({ output: { case: { moment: 'asked', case_id: 'k-case-x1', why: 'просили' } } }),
      null,
    )
    expect(told.severity).toBeNull()
    // A case in the answer of a move without a reply is no case told.
    const quiet = gradeScenario(
      scenarioOf({ move: 'call_boris', case: 'none' }),
      planOf({
        output: {
          move: 'call_boris',
          text: null,
          case: { moment: 'asked', case_id: 'k-case-x1', why: '' },
        },
        decision: CALL,
      }),
      null,
    )
    expect(quiet.severity).toBeNull()
  })

  it('FR-TRAIN-8: an Interlocutor that did not answer is one S2 failure, not a pile of them', () => {
    const g = gradeScenario(
      scenarioOf({ move: 'call_boris', topic: 'price', urgent: true }),
      planOf({
        output: null,
        failure: 'timeout',
        decision: {
          action: 'draft',
          would: 'draft',
          reason: 'Собеседник не ответил',
          holdUntil: null,
        },
      }),
      null,
    )
    expect(g.failures).toEqual([
      { id: 'run.failed', severity: 'S2', detail: expect.stringContaining('timeout') },
    ])
    expect(g.score).toBe(0.5)
  })

  it('FR-TRAIN-8: a Checker that did not answer on a reply is an unanswered scenario, not a clean one', () => {
    // Without the Checker its S1 findings are missing, and the rules turn the reply into a draft: nothing is proved.
    const g = gradeScenario(scenarioOf(), planOf({ checkerRan: false }), null)
    expect(g.failures).toEqual([
      { id: 'run.checker', severity: 'S2', detail: expect.stringContaining('Проверяющий') },
    ])
    expect(g.score).toBe(0.5)
    // A move with no text has nothing for the Checker to read.
    const quiet = gradeScenario(
      scenarioOf({ move: 'call_boris' }),
      planOf({ output: { move: 'call_boris', text: null }, decision: CALL, checkerRan: false }),
      null,
    )
    expect(quiet.severity).toBeNull()
  })

  it('FR-TRAIN-8: a failed judge that counts is an unanswered scenario, and one that does not count is not', () => {
    const counted = gradeScenario(scenarioOf(), planOf({}), null, {
      judgeCounts: true,
      judgeFailed: true,
    })
    expect(counted.failures).toEqual([
      { id: 'run.judge', severity: 'S2', detail: expect.stringContaining('судья') },
    ])
    const advisory = gradeScenario(scenarioOf(), planOf({}), null, { judgeFailed: true })
    expect(advisory.failures).toEqual([])
    expect(advisory.score).toBe(1)
  })

  describe('the judge', () => {
    const bad: ExaminerOutput = { tone: 2, voice: 2, procedure_ok: false, notes: 'шаблонно' }
    const good: ExaminerOutput = { tone: 5, voice: 4, procedure_ok: true, notes: 'хорошо' }

    it('FR-TRAIN-8: the marks of a judge not yet trusted are shown but do not change the score', () => {
      const g = gradeScenario(scenarioOf(), planOf({}), bad)
      expect(g.failures).toEqual([])
      expect(g.score).toBe(1)
      expect(g.severity).toBeNull()
      expect(g.advisory.map((x) => [x.id, x.severity])).toEqual([
        ['judge.procedure', 'S2'],
        ['judge.tone', 'S2'],
        ['judge.voice', 'S3'],
      ])
    })

    it('FR-TRAIN-8: with the judge trusted its marks count: procedure and tone S2, voice S3', () => {
      const g = gradeScenario(scenarioOf(), planOf({}), bad, { judgeCounts: true })
      expect(g.advisory).toEqual([])
      expect(g.failures.map((x) => x.id)).toEqual(['judge.procedure', 'judge.tone', 'judge.voice'])
      expect(g.score).toBe(0)
      const mild = gradeScenario(
        scenarioOf(),
        planOf({}),
        { ...good, voice: 2 },
        { judgeCounts: true },
      )
      expect(mild.score).toBe(0.8)
      expect(gradeScenario(scenarioOf(), planOf({}), good, { judgeCounts: true }).score).toBe(1)
    })

    it('FR-TRAIN-8: a judge never turns a scenario into an S1', () => {
      const g = gradeScenario(scenarioOf(), planOf({}), bad, { judgeCounts: true })
      expect(g.severity).toBe('S2')
    })
  })
})
