import { describe, expect, it } from 'vitest'
import { EVENT_TYPES } from '../src/contracts/eventTypes'
import {
  CHECK_IDS,
  CHECK_SEVERITY,
  CheckerOutput,
  ExaminerOutput,
  ExamScenario,
  formatCallback,
  InterlocutorOutput,
  LOCKED_TOPICS,
  MIND_ID_PREFIX,
  MIND_TYPES,
  MindFrontmatter,
  PROFI_ERROR_CLASSES,
  PROFI_EVENT_PAYLOADS,
  PROFI_TOOLS,
  parseCallback,
  ReminderOutput,
  SETTINGS,
  SendMessageInput,
  TASK_ACTIONS,
} from '../src/index'

const answer = {
  heard: { said: 'Спросила цену', behind: 'Боится переплатить' },
  question_type: 'u-price-question',
  topic: 'price',
  tone: 'doubt',
  move: 'call_boris',
  urgent: false,
  why: 'Цена тема Бориса',
  text: null,
  fact_ids: ['j-constitution'],
  example_ids: [],
  missing: null,
}

const v1Record = {
  id: 'price-basic',
  type: 'knowledge',
  scope: 'shared',
  status: 'confirmed',
  version: 1,
  sources: ['interview:2026-11-01'],
  valid_from: '2026-11-01',
  valid_to: null,
}

const scenario = {
  id: 'x-price-direct',
  title: 'Клиент сразу спрашивает цену',
  source: { kind: 'handmade', ref: null },
  tags: {
    question_type: 'u-price-question',
    stage: 'talking',
    tone: 'neutral',
    archetype: null,
    hard: false,
  },
  golden: false,
  order: { title: 'Сайт для клиники', text: 'Нужен сайт', budget_text: null, city: 'Краснодар' },
  client_name: 'Анна',
  messages: [
    {
      author: 'sara_v1',
      text: 'Анна, добрый день! Понимаю задачу.',
      at: '2026-10-20T10:00:00.000Z',
    },
    { author: 'client', text: 'Сколько это стоит?', at: '2026-10-20T10:05:00.000Z' },
  ],
  state: { owner: 'sara', owner_reason: null, boris_note: null },
  now: '2026-10-20T10:06:00.000Z',
  expect: { move: 'call_boris' },
}

const ref = {
  chat_id: '95147898',
  order_id: '95147898',
  platform_message_id: 'm-1',
  sent_at: '2026-10-20T10:05:00.000Z',
  author: 'specialist',
}

describe('M4 contracts', () => {
  it('FR-CONV-3: the Interlocutor answer keeps the thinking order and cites mind ids', () => {
    expect(Object.keys(InterlocutorOutput.shape)).toEqual([
      'heard',
      'question_type',
      'topic',
      'tone',
      'move',
      'urgent',
      'why',
      'case',
      'sites',
      'text',
      'fact_ids',
      'example_ids',
      'missing',
    ])
    expect(InterlocutorOutput.safeParse(answer).success).toBe(true)
    expect(
      InterlocutorOutput.safeParse({ ...answer, fact_ids: Array(13).fill('k-a') }).success,
    ).toBe(false)
    expect(InterlocutorOutput.safeParse({ ...answer, tone: 'sad' }).success).toBe(false)
  })

  it('FR-CONV-4: the case of an answer is optional, one of four moments, and an old answer still reads', () => {
    // An answer from before cases has no `case`.
    expect(InterlocutorOutput.safeParse(answer).data?.case).toBeUndefined()
    const chosen = { moment: 'asked', case_id: 'k-case-01', why: 'Клиент спросил о примерах' }
    expect(InterlocutorOutput.safeParse({ ...answer, case: chosen }).success).toBe(true)
    expect(
      InterlocutorOutput.safeParse({
        ...answer,
        case: { moment: null, case_id: null, why: null },
      }).success,
    ).toBe(true)
    for (const moment of ['asked', 'order_asks', 'doubt', 'same_problem'])
      expect(InterlocutorOutput.safeParse({ ...answer, case: { ...chosen, moment } }).success).toBe(
        true,
      )
    expect(
      InterlocutorOutput.safeParse({ ...answer, case: { ...chosen, moment: 'always' } }).success,
    ).toBe(false)
    expect(
      InterlocutorOutput.safeParse({ ...answer, case: { ...chosen, why: 'x'.repeat(301) } })
        .success,
    ).toBe(false)
    // The Checker's case notes default to none.
    expect(
      CheckerOutput.parse({ unsupported: [], contradicts_boris: null, robotic: [], promises: [] })
        .case,
    ).toEqual([])
    expect(
      CheckerOutput.safeParse({
        unsupported: [],
        contradicts_boris: null,
        robotic: [],
        promises: [],
        case: Array(6).fill('x'),
      }).success,
    ).toBe(false)
    for (const id of ['case.unknown', 'case.closed'])
      expect(CHECK_SEVERITY[id as 'case.unknown']).toBe('S1')
    for (const id of ['case.no_moment', 'case.repeat', 'case.many', 'checker.case'])
      expect(CHECK_SEVERITY[id as 'case.repeat']).toBe('S2')
    for (const id of ['case.ad', 'case.link']) expect(CHECK_SEVERITY[id as 'case.ad']).toBe('S3')
  })

  it('FR-CONV-4: the Checker, reminder and judge answers have their shapes', () => {
    expect(
      CheckerOutput.safeParse({
        unsupported: [],
        contradicts_boris: null,
        robotic: [],
        promises: [],
      }).success,
    ).toBe(true)
    expect(ReminderOutput.safeParse({ text: '', fact_ids: [] }).success).toBe(false)
    expect(
      ExaminerOutput.safeParse({ tone: 6, voice: 3, procedure_ok: true, notes: '' }).success,
    ).toBe(false)
  })

  it('FR-AUTO-2: price, contract, discount and NDA are the locked topics', () => {
    expect([...LOCKED_TOPICS]).toEqual(['price', 'contract', 'discount', 'nda'])
  })

  it('FR-CONV-4: every check has a severity and a fact outside the mind is S1', () => {
    for (const id of CHECK_IDS) expect(CHECK_SEVERITY[id]).toMatch(/^S[123]$/)
    expect(CHECK_SEVERITY['facts.numbers']).toBe('S1')
    expect(CHECK_SEVERITY['facts.none']).toBe('S1')
    expect(CHECK_SEVERITY['promise.call']).toBe('S1')
    expect(CHECK_SEVERITY['greeting.missing']).toBe('S2')
    expect(CHECK_SEVERITY['robotic.phrase']).toBe('S3')
  })

  it('FR-MIND-1: version 2 fields are optional, so a version 1 record still parses', () => {
    expect(MindFrontmatter.safeParse(v1Record).success).toBe(true)
    expect(
      MindFrontmatter.safeParse({ ...v1Record, tones: ['joke'], topic: 'price', title: 'Цена' })
        .success,
    ).toBe(true)
    expect(MindFrontmatter.safeParse({ ...v1Record, tones: ['sad'] }).success).toBe(false)
    expect(MindFrontmatter.safeParse({ ...v1Record, stages: ['won'] }).success).toBe(false)
    for (const t of MIND_TYPES) expect(MIND_ID_PREFIX[t]).toMatch(/^[a-z]-$/)
  })

  it('FR-TRAIN-8: an exam scenario needs an id x-…, at least one message and an expected move', () => {
    expect(ExamScenario.safeParse(scenario).success).toBe(true)
    expect(ExamScenario.safeParse({ ...scenario, id: 'price' }).success).toBe(false)
    expect(ExamScenario.safeParse({ ...scenario, messages: [] }).success).toBe(false)
    expect(ExamScenario.safeParse({ ...scenario, expect: {} }).success).toBe(false)
    const parsed = ExamScenario.parse(scenario)
    expect(parsed.expect.must_not_contain).toEqual([])
    expect(parsed.expect.boris_reply).toBeNull()
    expect(parsed.bid).toBeNull()
  })

  it('FR-TRAIN-8: a scenario keeps an unknown specialist author, the bid, the category and the greeting', () => {
    const full = {
      ...scenario,
      order: { ...scenario.order, category: 'Сайты' },
      bid: { text: 'Анна, добрый день! Понимаю задачу.', author: 'unknown' },
      messages: [
        { author: 'unknown', text: 'Ответ нашей стороны', at: scenario.now },
        ...scenario.messages,
      ],
      expect: { move: 'reply', greeting: true },
    }
    const parsed = ExamScenario.parse(full)
    expect(parsed.bid?.author).toBe('unknown')
    expect(parsed.order.category).toBe('Сайты')
    expect(parsed.expect.greeting).toBe(true)
    expect(ExamScenario.safeParse({ ...full, extra: 1 }).success).toBe(false)
    expect(
      ExamScenario.safeParse({ ...full, state: { ...full.state, owner: 'paused' } }).success,
    ).toBe(true)
  })

  it('FR-TRAIN-8: a scenario carries its own invented cases, a trap mark and the case it expects', () => {
    const parsed = ExamScenario.parse(scenario)
    expect(parsed.cases).toEqual([])
    expect(parsed.tags.trap).toBe(false)
    expect(parsed.expect.case).toBeUndefined()
    const withCase = {
      ...scenario,
      tags: { ...scenario.tags, trap: true },
      cases: [
        {
          id: 'k-case-x1',
          title: 'Лиса-Клиник: онлайн-запись, Краснодар',
          summary: 'Сделали сайт с онлайн-записью.',
          role: 'Сайт и аналитика.',
          result: 'Заявок стало больше.',
          show_rules: ['Компанию можно называть.'],
          name_open: true,
          numbers_open: false,
        },
      ],
      expect: { ...scenario.expect, case: 'needed' },
    }
    const full = ExamScenario.parse(withCase)
    expect(full.cases[0]?.id).toBe('k-case-x1')
    expect(full.expect.case).toBe('needed')
    expect(
      ExamScenario.safeParse({ ...withCase, expect: { move: 'reply', case: 'maybe' } }).success,
    ).toBe(false)
    const [first] = withCase.cases
    expect(
      ExamScenario.safeParse({ ...withCase, cases: [{ ...first, id: 'case-1' }] }).success,
    ).toBe(false)
    expect(
      ExamScenario.safeParse({ ...withCase, cases: [{ ...first, extra: true }] }).success,
    ).toBe(false)
  })

  it('FR-CONV-10: specialist message, typing and read events carry no text', () => {
    expect(PROFI_EVENT_PAYLOADS['profi.specialist_message'].safeParse(ref).success).toBe(true)
    expect(
      PROFI_EVENT_PAYLOADS['profi.specialist_message'].safeParse({ ...ref, text: 'привет' })
        .success,
    ).toBe(false)
    expect(
      PROFI_EVENT_PAYLOADS['profi.specialist_message'].safeParse({ ...ref, author: 'client' })
        .success,
    ).toBe(false)
    expect(
      PROFI_EVENT_PAYLOADS['profi.client_typing'].safeParse({ chat_id: 'c', at: ref.sent_at })
        .success,
    ).toBe(true)
    expect(
      PROFI_EVENT_PAYLOADS['profi.client_read'].safeParse({
        chat_id: 'c',
        platform_message_id: null,
        at: ref.sent_at,
        text: 'x',
      }).success,
    ).toBe(false)
  })

  it('FR-CONV-6: sending names the last message the core saw and the node can refuse a changed chat', () => {
    expect(PROFI_TOOLS['profi.send_message'].input).toBe(SendMessageInput)
    expect(
      SendMessageInput.safeParse({
        account_id: 'a',
        chat_id: 'c',
        text: 'Добрый день',
        expect_last_message_id: null,
        idempotency_key: 'msg:t:1',
        permit: 'p',
      }).success,
    ).toBe(true)
    expect(PROFI_ERROR_CLASSES).toContain('CHAT_CHANGED')
  })

  it('FR-CONV-5: conversation settings have the design defaults', () => {
    expect(SETTINGS['pipeline.conversations'].default).toBe(false)
    expect(SETTINGS['conv.v1_writes'].default).toBe(true)
    expect(SETTINGS['conv.autopilot'].default).toBe(false)
    expect(SETTINGS['conv.quiet_after_message_s'].default).toBe(45)
    expect(SETTINGS['conv.quiet_after_typing_s'].default).toBe(20)
    expect(SETTINGS['conv.max_wait_s'].default).toBe(600)
    expect(SETTINGS['conv.night'].default).toEqual({ from: 23, to: 8 })
    expect(SETTINGS['conv.reminder_quiet'].default).toEqual({ from: 23, to: 9 })
    expect(SETTINGS['conv.cards_per_day'].default).toBe(10)
    expect(SETTINGS['conv.reminders'].default).toBe(true)
    expect(SETTINGS['mind.vectors'].default).toBe(false)
    const autonomy = SETTINGS['conv.autonomy']
    expect(autonomy.default.price).toBe('call')
    expect(autonomy.default.process).toBe('draft')
    expect(autonomy.schema.safeParse({ ...autonomy.default, price: 'self' }).success).toBe(false)
    expect(autonomy.schema.safeParse({ ...autonomy.default, process: 'self' }).success).toBe(true)
  })

  it('FR-AUTO-2: a saved autonomy value survives a change of the topic list', () => {
    const schema = SETTINGS['conv.autonomy'].schema
    const old = schema.parse({
      price: 'call',
      contract: 'call',
      discount: 'call',
      nda: 'call',
      process: 'self',
      gone: 'self',
    })
    expect(old.process).toBe('self')
    expect(old.timeline).toBe('draft')
    expect('gone' in old).toBe(false)
    expect(schema.safeParse({ process: 'self' }).data?.price).toBe('call')
    expect(schema.safeParse({ price: 'draft' }).success).toBe(false)
  })

  it('FR-CONV-11: the draft card buttons good and close fit the callback', () => {
    const id = '0192f3c4-5b6a-7c8d-9e0f-112233445566'
    expect(parseCallback(formatCallback(id, 'good'))).toEqual({ taskId: id, action: 'good' })
    expect(parseCallback(formatCallback(id, 'close'))).toEqual({ taskId: id, action: 'close' })
  })

  it('FR-CONV-12: the card of a reminder (send, edit, skip) fits the callback, «Напоминать дальше» is gone', () => {
    const id = '0192f3c4-5b6a-7c8d-9e0f-112233445566'
    for (const action of ['send', 'edit', 'skip'] as const)
      expect(parseCallback(formatCallback(id, action))).toEqual({ taskId: id, action })
    // The old button of a task from before: nothing in the core answers it any more.
    expect(TASK_ACTIONS).not.toContain('remind')
    expect(parseCallback(`t:${id}:remind`)).toBeNull()
  })

  it('FR-OPS-4: the M4 journal events are known', () => {
    for (const t of [
      'conv.turn_drafted',
      'conv.boris_wrote',
      'conv.compared',
      'conv.day_summary',
      'mind.indexed',
      'mind.proposed',
      'history.exported',
      'exam.finished',
    ])
      expect(EVENT_TYPES).toContain(t)
  })
})
