import { newEventId, parseCallback } from '@sara/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lesson, mindGap, mindProposal, modelCall, question } from '../../src/db/schema'
import { handleBorisMessage } from '../../src/learning/inbox'
import type { Notifier } from '../../src/notify/notifier'
import {
  answerInterview,
  confirmInterview,
  interviewAnswersStep,
  interviewQueue,
  interviewStep,
  onSchoolAnswer,
  skipInterview,
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
/** Minutes after NOW: every test runs on its own clock, never the real one. */
const at = (min: number) => new Date(NOW.getTime() + min * 60_000)
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

function fakes(o: { refuseCards?: number; refuse?: string } = {}) {
  let refuse = o.refuseCards ?? 0
  const edits: { id: number; text: string; rows: unknown[] }[] = []
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
    editText: async (id, text, rows) => {
      edits.push({ id, text, rows: rows ?? [] })
    },
  }
  const writer: MindWriter = {
    apply: async (ids, why) => {
      applied.push(ids)
      if (o.refuse) {
        // As the real writer: every proposal refused, the lesson becomes «нет».
        await db.update(lesson).set({ state: 'no' }).where(inArray(lesson.id, why.lessonIds))
        return {
          ok: false,
          reason: 'nothing',
          detail: 'всё отклонено проверкой',
          refused: ids.map((proposalId) => ({ proposalId, reason: o.refuse ?? '' })),
        }
      }
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

/** Boris's words to Sara's message (a reply when `replyTo` is given), through the inbox as in production. */
const answer = (
  d: Parameters<typeof onSchoolAnswer>[0],
  text: string,
  replyTo: number | null,
  when: Date,
) =>
  handleBorisMessage(
    {
      db,
      transcriber: { transcribe: async () => null },
      onSchoolAnswer: (a) => onSchoolAnswer(d, a),
    },
    { text, voicePath: null, replyToMessageId: replyTo, at: when },
  )

/** A button of a card: row and column → its task and action. */
const press = (
  card: { rows: { callbackData: string }[][] } | undefined,
  row: number,
  col: number,
) =>
  parseCallback(card?.rows[row]?.[col]?.callbackData ?? '') as { taskId: string; action: 'apply' }

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

  it('FR-MIND-4: an answer becomes a knowledge record, and its gaps close only once it is written', async () => {
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
    // Written on the school's tick, never inside the press; the question is not asked again meanwhile.
    expect(f.applied).toEqual([])
    expect((await db.select().from(mindGap)).every((g) => g.lessonId === null)).toBe(true)
    expect(await interviewQueue(db, NOW)).toEqual([])
    await writePending({ db, notifier: f.notifier, writer: f.writer })
    expect(f.applied).toEqual([[p?.id]])
    expect(
      (await db.select().from(mindGap)).every((g) => g.lessonId === r.understood.lessonId),
    ).toBe(true)
    expect(await interviewQueue(db, NOW)).toEqual([])
  })

  it('FR-MIND-4: a record the guard refuses leaves the question open and says why on the card', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes({ refuse: 'число 80000 Борис не называл' })
    const gw = await fakeGateway(db, { 'lesson-maker': FACT })
    const d = { db, notifier: f.notifier, gateway: gw.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await answer(d, 'сайт от восьмидесяти тысяч', f.texts[0]?.id ?? null, at(5))
    await interviewAnswersStep(d, at(6))
    await onSchoolPress(d, press(f.cards[0], 0, 0), at(7))
    await writePending(d)
    expect(f.edits.at(-1)?.text).toContain('Не записала: число 80000 Борис не называл')
    expect(f.edits.at(-1)?.rows).toEqual([])
    expect((await db.select().from(mindGap)).every((g) => g.lessonId === null)).toBe(true)
    expect(await interviewQueue(db, at(8))).toHaveLength(1)
  })

  it("FR-MIND-4: the day's question goes once, its answer by voice becomes a card, and «Поправить» asks again", async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    const gw = await fakeGateway(db, { 'lesson-maker': FACT })
    const d = { db, notifier: f.notifier, gateway: gw.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await interviewStep(d, msk('2026-10-26', '15:00'))
    expect(f.texts.filter((t) => t.text.startsWith('❓'))).toHaveLength(1)
    const reply = await handleBorisMessage(
      {
        db,
        transcriber: { transcribe: async () => 'сайт от 80 000' },
        onSchoolAnswer: (a) => onSchoolAnswer(d, a),
      },
      { text: null, voicePath: '/tmp/v.oga', replyToMessageId: f.texts[0]?.id ?? null, at: at(5) },
    )
    expect(reply).toBe(SCHOOL_TEXTS.interviewThinking)
    // The model is called on the school's tick, not while Boris's message is handled.
    expect(await gw.calls()).toHaveLength(0)
    await interviewAnswersStep(d, at(6))
    await interviewAnswersStep(d, at(7))
    expect(await gw.calls()).toHaveLength(1)
    const card = f.cards[0]
    expect(card?.text).toContain('Я поняла так: Цена сайта')
    expect(card?.text).toContain('Правильно понимаю?')
    expect(await onSchoolPress(d, press(card, 0, 1), at(8))).toBe('Жду поправку')
    expect(f.edits.at(-1)?.rows).toEqual([])
    const fixAsk = f.texts.find((t) => t.text.startsWith('Что поправить'))
    await answer(d, 'не от 80, а от 90 000', fixAsk?.id ?? null, at(9))
    await interviewAnswersStep(d, at(10))
    expect(f.cards).toHaveLength(2)
    const states = (await db.select().from(lesson)).map((l) => l.state).sort()
    expect(states).toEqual(['asked', 'skip'])
    const write = press(f.cards[1], 0, 0)
    expect(await onSchoolPress(d, write, at(11))).toBe('Записываю в разум')
    expect(await onSchoolPress(d, write, at(11))).toBe('Уже сделано')
    await writePending(d)
    expect(f.applied).toHaveLength(1)
    expect(f.edits.at(-1)?.text).toContain('Я поняла так: Цена сайта')
    expect(f.edits.at(-1)?.text).toContain('Записала в разум')
  })

  it('FR-MIND-4: an answer Sara could not understand is asked again, and the new answer is taken', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    const gw = await fakeGateway(db, {
      'lesson-maker': { $sequence: [{ ...FACT, fact: null }, FACT] },
    })
    const d = { db, notifier: f.notifier, gateway: gw.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await answer(d, 'ну как-то так', f.texts[0]?.id ?? null, at(5))
    await interviewAnswersStep(d, at(6))
    await interviewAnswersStep(d, at(7))
    expect(await gw.calls()).toHaveLength(1)
    expect(await db.select().from(lesson)).toEqual([])
    const again = f.texts.find((t) => t.text.startsWith('❓ Не поняла ответ'))
    expect(again?.text).toContain('цена сайта')
    await answer(d, 'Сайт от 80 000', again?.id ?? null, at(8))
    await interviewAnswersStep(d, at(9))
    expect(f.cards).toHaveLength(1)
  })

  it('FR-MIND-4: while the Claude limit holds, the answer waits and is never called «не понятым»', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    const limited = await fakeGateway(db, { 'lesson-maker': FACT }, { FAKE_CLAUDE_MODE: 'limit' })
    const d = { db, notifier: f.notifier, gateway: limited.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await answer(d, 'Сайт от 80 000', f.texts[0]?.id ?? null, at(5))
    await interviewAnswersStep(d, at(6))
    expect(f.texts.some((t) => t.text.includes('Не поняла'))).toBe(false)
    expect(f.texts.filter((t) => t.text.startsWith('❓'))).toHaveLength(1)
    // The limit is over: the journal holds no limit any more, so a new gateway calls the model.
    await db.delete(modelCall)
    const ok = await fakeGateway(db, { 'lesson-maker': FACT })
    await interviewAnswersStep({ ...d, gateway: ok.gateway }, at(60))
    expect(f.cards).toHaveLength(1)
  })

  it('FR-MIND-4: a card Telegram refused comes on the next tick without a second model call', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes({ refuseCards: 1 })
    const gw = await fakeGateway(db, { 'lesson-maker': FACT })
    const d = { db, notifier: f.notifier, gateway: gw.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await answer(d, 'Сайт от 80 000', f.texts[0]?.id ?? null, at(5))
    await interviewAnswersStep(d, at(6))
    expect(f.cards).toHaveLength(0)
    await interviewAnswersStep(d, at(7))
    expect(f.cards).toHaveLength(1)
    expect(await gw.calls()).toHaveLength(1)
    expect((await db.select().from(lesson)).map((l) => l.state)).toEqual(['asked'])
  })

  it('FR-MIND-4: a question whose card waits is not asked again the next day', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    const gw = await fakeGateway(db, { 'lesson-maker': FACT })
    const d = { db, notifier: f.notifier, gateway: gw.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await answer(d, 'Сайт от 80 000', f.texts[0]?.id ?? null, at(5))
    await interviewAnswersStep(d, at(6))
    await interviewStep(d, msk('2026-10-27', '11:00'))
    expect(f.texts.filter((t) => t.text.startsWith('❓'))).toHaveLength(1)
  })

  it("FR-MIND-4: a plain message with the interview question and a lead's «почему?» open asks which", async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    const d = { db, notifier: f.notifier }
    await db.insert(question).values({
      id: newEventId(),
      kind: 'why_skip',
      entityId: 'order-1',
      telegramMessageId: 9999,
      askedAt: at(-5).toISOString(),
    })
    await interviewStep(d, NOW)
    const reply = await answer(d, 'клиент дорогой', null, at(5))
    expect(reply).toContain('Не поняла, к какому моему вопросу')
    expect(await db.select().from(question).where(eq(question.kind, 'interview'))).toEqual([
      expect.objectContaining({ answeredAt: null }),
    ])
  })

  it('FR-MIND-4: «Не знаю, пропустить» keeps the question away for a week', async () => {
    await gap('conv-turn:1', 'цена сайта')
    const f = fakes()
    const gw = await fakeGateway(db, { 'lesson-maker': FACT })
    const d = { db, notifier: f.notifier, gateway: gw.gateway, writer: f.writer }
    await interviewStep(d, NOW)
    await answer(d, 'не знаю', f.texts[0]?.id ?? null, at(5))
    await interviewAnswersStep(d, at(6))
    expect(await onSchoolPress(d, press(f.cards[0], 1, 0), at(7))).toBe(
      SCHOOL_TEXTS.interviewSkipped,
    )
    expect(f.edits.at(-1)?.text).toContain(SCHOOL_TEXTS.interviewSkipped)
    expect(await interviewQueue(db, msk('2026-10-30', '11:00'))).toEqual([])
    expect(await interviewQueue(db, msk('2026-11-03', '11:00'))).toHaveLength(1)
    expect(f.applied).toEqual([])
    expect(skipInterview).toBeTypeOf('function')
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
