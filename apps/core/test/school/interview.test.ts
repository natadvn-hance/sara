import { newEventId, parseCallback } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lesson, mindGap, mindProposal, question } from '../../src/db/schema'
import { handleBorisMessage } from '../../src/learning/inbox'
import type { Notifier } from '../../src/notify/notifier'
import {
  answerInterview,
  confirmInterview,
  interviewAnswersStep,
  interviewQueue,
  interviewStep,
  onSchoolAnswer,
} from '../../src/school/interview'
import { onSchoolPress, writePending } from '../../src/school/lessons/batches'
import { SCHOOL_TEXTS } from '../../src/school/texts'
import type { MindWriter } from '../../src/school/types'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  await setSetting(db, 'school.on', true, 'boris')
})

const msk = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`)
const NOW = msk('2026-10-26', '11:00')
const FACT = {
  worth: true,
  insight: 'Сайт от 80 000',
  kind: 'fact',
  topic: 'price',
  tone: 'neutral',
  fact: { title: 'Цена сайта', fact: 'Сайт от 80 000', when: 'после созвона', not_say: 'скидки' },
}

async function gap(turnId: string, text: string, daysAgo = 0) {
  await db.insert(mindGap).values({
    id: newEventId(),
    turnId,
    text,
    topic: 'price',
    createdAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
  })
}

function fakes(o: { refuseCards?: number } = {}) {
  let refuse = o.refuseCards ?? 0
  const edits: { id: number; text: string }[] = []
  const texts: { id: number; text: string }[] = []
  const cards: { text: string; rows: { text: string; callbackData: string }[][] }[] = []
  const applied: string[][] = []
  let next = 1
  const notifier: Notifier = {
    sendLeadCard: async () => ({ messageId: next++ }),
    sendText: async (text) => {
      const id = next++
      texts.push({ id, text })
      return { messageId: id }
    },
    sendButtons: async (text, rows) => {
      if (refuse > 0) {
        refuse--
        throw new Error('telegram is down')
      }
      cards.push({ text, rows })
      return { messageId: next++ }
    },
    editText: async (id, text) => {
      edits.push({ id, text })
    },
  }
  const writer: MindWriter = {
    apply: async (ids) => {
      applied.push(ids)
      return {
        ok: true,
        commitId: newEventId(),
        sha: 'a',
        mindVersion: 'v',
        written: ids,
        refused: [],
      }
    },
    revert: async (id) => ({ ok: true, commitId: id }),
    sync: async () => ({ pushed: false, pulled: 0, error: null }),
  }
  return { notifier, writer, texts, cards, edits, applied }
}

describe('the interview', () => {
  it("FR-MIND-4: real gaps come before the teacher's and the generator's, the frequent first", async () => {
    await gap('sim:d1:1', 'сколько стоит логотип')
    await gap('teacher:r1:0', 'Делаете ли вы сайты на Тильде?')
    await gap('conv-turn:1', 'цена настройки рекламы')
    await gap('conv-turn:2', 'срок запуска рекламы')
    await gap('conv-turn:3', 'Цена настройки рекламы.')
    await gap('conv-turn:4', 'старый вопрос', 20)
    const q = await interviewQueue(db, NOW)
    expect(q.map((x) => [x.source, x.count])).toEqual([
      ['work', 2],
      ['work', 1],
      ['teacher', 1],
      ['sim', 1],
    ])
    expect(q[0]?.question).toBe('Клиенты спрашивают: «цена настройки рекламы». Как им отвечать?')
    expect(q[2]?.question).toBe('Делаете ли вы сайты на Тильде?')
  })

  it('FR-MIND-4: an answer becomes a knowledge record after «Правильно понимаю?», and the gap closes', async () => {
    await gap('conv-turn:1', 'цена сайта')
    await gap('conv-turn:2', 'Цена сайта')
    const f = fakes()
    const gw = await fakeGateway(db, { 'lesson-maker': FACT })
    const [q] = await interviewQueue(db, NOW)
    const r = await answerInterview(
      { db, gateway: gw.gateway },
      q?.gapKey ?? '',
      'Сайт от 80 000, после созвона',
      NOW,
    )
    if (!r.ok) throw new Error(r.reason)
    expect(r.understood).toMatchObject({ title: 'Цена сайта', fact: 'Сайт от 80 000' })
    expect((await gw.calls())[0]?.model).toBe('sonnet')
    const [p] = await db.select().from(mindProposal)
    expect(p?.recordId).toMatch(/^k-i-\d+$/)
    expect(await confirmInterview({ db }, r.understood.lessonId)).toBe('Записываю в разум')
    // Written on the school's tick, never inside the press.
    expect(f.applied).toEqual([])
    await writePending({ db, notifier: f.notifier, writer: f.writer })
    expect(f.applied).toEqual([[p?.id]])
    expect(
      (await db.select().from(mindGap)).every((g) => g.lessonId === r.understood.lessonId),
    ).toBe(true)
    expect(await interviewQueue(db, NOW)).toEqual([])
  })

  it("FR-MIND-4: the day's question goes once, its answer by voice becomes a card, and «Поправить» asks again", async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    const gw = await fakeGateway(db, { 'lesson-maker': FACT })
    const d = { db, notifier: f.notifier, gateway: gw.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await interviewStep(d, msk('2026-10-26', '15:00'))
    expect(f.texts.filter((t) => t.text.startsWith('❓'))).toHaveLength(1)
    const ask = f.texts[0]
    const reply = await handleBorisMessage(
      {
        db,
        transcriber: { transcribe: async () => 'сайт от восьмидесяти тысяч' },
        onSchoolAnswer: (a) => onSchoolAnswer(d, a),
      },
      { text: null, voicePath: '/tmp/v.oga', replyToMessageId: ask?.id ?? null, at: new Date() },
    )
    expect(reply).toBe(SCHOOL_TEXTS.interviewThinking)
    // The model is called on the school's tick, not while Boris's message is handled.
    expect(await gw.calls()).toHaveLength(0)
    await interviewAnswersStep(d, new Date())
    await interviewAnswersStep(d, new Date())
    expect(await gw.calls()).toHaveLength(1)
    const card = f.cards[0]
    expect(card?.text).toContain('Я поняла так: Цена сайта')
    expect(card?.text).toContain('Правильно понимаю?')
    const fix = parseCallback(card?.rows[0]?.[1]?.callbackData ?? '') as {
      taskId: string
      action: 'edit'
    }
    expect(await onSchoolPress(d, fix, new Date())).toBe('Жду поправку')
    const fixAsk = f.texts.find((t) => t.text.startsWith('Что поправить'))
    await handleBorisMessage(
      {
        db,
        transcriber: { transcribe: async () => null },
        onSchoolAnswer: (a) => onSchoolAnswer(d, a),
      },
      {
        text: 'не от 80, а от 90 000',
        voicePath: null,
        replyToMessageId: fixAsk?.id ?? null,
        at: new Date(),
      },
    )
    await interviewAnswersStep(d, new Date())
    expect(f.cards).toHaveLength(2)
    const states = (await db.select().from(lesson)).map((l) => l.state).sort()
    expect(states).toEqual(['asked', 'skip'])
    const write = parseCallback(f.cards[1]?.rows[0]?.[0]?.callbackData ?? '') as {
      taskId: string
      action: 'apply'
    }
    expect(await onSchoolPress(d, write, new Date())).toBe('Записываю в разум')
    expect(await onSchoolPress(d, write, new Date())).toBe('Уже сделано')
    await writePending(d)
    expect(f.applied).toHaveLength(1)
    expect(f.edits.at(-1)?.text).toContain('Я поняла так: Цена сайта')
    expect(f.edits.at(-1)?.text).toContain('Записала в разум')
  })

  it('FR-MIND-4: an answer Sara could not understand is told once, with one model call', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    const gw = await fakeGateway(db, { 'lesson-maker': { ...FACT, fact: null } })
    const d = { db, notifier: f.notifier, gateway: gw.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await handleBorisMessage(
      {
        db,
        transcriber: { transcribe: async () => null },
        onSchoolAnswer: (a) => onSchoolAnswer(d, a),
      },
      {
        text: 'ну как-то так',
        voicePath: null,
        replyToMessageId: f.texts[0]?.id ?? null,
        at: new Date(),
      },
    )
    await interviewAnswersStep(d, new Date())
    await interviewAnswersStep(d, new Date())
    expect(f.texts.filter((t) => t.text === SCHOOL_TEXTS.interviewNotUnderstood)).toHaveLength(1)
    expect(await gw.calls()).toHaveLength(1)
    expect(await db.select().from(lesson)).toEqual([])
  })

  it('FR-MIND-4: a card Telegram refused leaves no lesson, and the next tick sends it', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes({ refuseCards: 1 })
    const gw = await fakeGateway(db, { 'lesson-maker': FACT })
    const d = { db, notifier: f.notifier, gateway: gw.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await handleBorisMessage(
      {
        db,
        transcriber: { transcribe: async () => null },
        onSchoolAnswer: (a) => onSchoolAnswer(d, a),
      },
      {
        text: 'Сайт от 80 000',
        voicePath: null,
        replyToMessageId: f.texts[0]?.id ?? null,
        at: new Date(),
      },
    )
    await interviewAnswersStep(d, new Date())
    expect(await db.select().from(lesson)).toEqual([])
    expect(await db.select().from(mindProposal)).toEqual([])
    await interviewAnswersStep(d, new Date())
    expect(f.cards).toHaveLength(1)
    expect((await db.select().from(lesson)).map((l) => l.state)).toEqual(['asked'])
  })

  it('FR-MIND-4: «Не знаю, пропустить» keeps the question away for a week', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    const gw = await fakeGateway(db, { 'lesson-maker': FACT })
    const [q] = await interviewQueue(db, NOW)
    const r = await answerInterview({ db, gateway: gw.gateway }, q?.gapKey ?? '', 'не знаю', NOW)
    if (!r.ok) throw new Error(r.reason)
    const { skipInterview } = await import('../../src/school/interview')
    await skipInterview(db, r.understood.lessonId, NOW)
    expect(await interviewQueue(db, msk('2026-10-30', '11:00'))).toEqual([])
    expect(await interviewQueue(db, msk('2026-11-03', '11:00'))).toHaveLength(1)
    expect(f.applied).toEqual([])
  })

  it('FR-NOTIF-3: no interview question at night and none when the school is off', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    await interviewStep({ db, notifier: f.notifier }, msk('2026-10-26', '23:30'))
    await setSetting(db, 'school.on', false, 'boris')
    await interviewStep({ db, notifier: f.notifier }, NOW)
    expect(f.texts).toHaveLength(0)
    expect(await db.select().from(question).where(eq(question.kind, 'interview'))).toHaveLength(0)
  })
})
