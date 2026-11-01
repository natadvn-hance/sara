import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { renderCard } from '../../src/analytics/insights/card'
import type { Finding } from '../../src/analytics/insights/findings'
import {
  insightsStep,
  onHypothesisPress,
  publish,
  type Told,
  toldBefore,
} from '../../src/analytics/insights/job'
import { gap } from '../../src/analytics/insights/stats'
import { analyticsHypothesis, task } from '../../src/db/schema'
import type { Gateway } from '../../src/gateway/gateway'
import type { Notifier } from '../../src/notify/notifier'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

type Sent = {
  text: string
  rows: { text: string; callbackData: string }[][]
  place: unknown
  quiet: unknown
}
let sent: Sent[] = []
let failSend = false
const notifier: Pick<Notifier, 'sendButtons'> = {
  sendButtons: async (text, rows, o) => {
    if (failSend) throw new Error('telegram is down')
    sent.push({ text, rows, place: o?.place, quiet: o?.quiet })
    return { messageId: 77 }
  },
}
let asked = 0
const gateway: Gateway = {
  call: async () => {
    asked++
    throw new Error('the model must not be asked when nothing passes')
  },
}

// 02.11.2026: 11:00 and 09:00 in Moscow (UTC+3).
const AT_1100 = new Date('2026-11-02T08:00:00Z')
const AT_0900 = new Date('2026-11-02T06:00:00Z')

const finding = (fingerprint: string): Finding => ({
  fingerprint,
  level: 'early',
  flow: 'bids',
  outcome: 'replied',
  dim: 'delay',
  group: 'отклик за 5 минут и быстрее',
  gap: gap({ k: 8, n: 10 }, { k: 8, n: 40 }),
  from: '2026-10-24',
  to: '2026-10-30',
  source: 'отклики Сары',
})
const told = (fingerprint: string): Told => {
  const f = finding(fingerprint)
  return { finding: f, text: renderCard(f, null).text, model: false }
}

beforeEach(async () => {
  await resetDb(db)
  sent = []
  asked = 0
  failSend = false
})

describe("the day's hypotheses", () => {
  it('FR-ANL: off by default, and not before ten Moscow time', async () => {
    expect(await insightsStep({ db, notifier, gateway, mode: 'off' }, AT_1100)).toBe('off')
    expect(await insightsStep({ db, notifier, gateway, mode: 'post' }, AT_0900)).toBe('not_yet')
  })

  it('FR-ANL: with nothing to say Sara is silent, asks no model, and the day is taken', async () => {
    expect(await insightsStep({ db, notifier, gateway, mode: 'post' }, AT_1100)).toBe('silent')
    expect(asked).toBe(0)
    expect(sent).toEqual([])
    expect(await insightsStep({ db, notifier, gateway, mode: 'post' }, AT_1100)).toBe('already')
  })

  it('FR-ANL: a hypothesis goes quietly to the analytics topic with «Проверяем» and «Не то», and is kept', async () => {
    await publish({ db, notifier }, 'post', [told('a')])
    expect(sent).toHaveLength(1)
    expect(sent[0]?.place).toBe('analytics')
    expect(sent[0]?.quiet).toBe(true)
    expect(sent[0]?.rows[0]?.map((b) => b.text)).toEqual(['Проверяем', 'Не то'])
    const [h] = await db.select().from(analyticsHypothesis)
    expect(h).toMatchObject({ fingerprint: 'a', level: 'early', status: 'shown' })
    const [t] = await db.select().from(task)
    expect(t).toMatchObject({ kind: 'analytics_hypothesis', state: 'open', telegramMessageId: 77 })
  })

  it('FR-ANL: a hypothesis Boris never saw does not count as told', async () => {
    failSend = true
    await expect(publish({ db, notifier }, 'post', [told('a')])).rejects.toThrow('telegram is down')
    expect(await db.select().from(analyticsHypothesis)).toEqual([])
    expect(await db.select().from(task)).toEqual([])
  })

  it('FR-ANL: «Не то» silences it for a month and a second press changes nothing', async () => {
    await publish({ db, notifier }, 'post', [told('a')])
    const [t] = await db.select().from(task)
    const marks: string[] = []
    const d = { db, markDone: async (_id: number, note: string) => void marks.push(note) }
    expect(await onHypothesisPress(d, { taskId: t?.id ?? '', action: 'drop' }, AT_1100)).toBe(
      'Поняла, больше не покажу',
    )
    expect(marks).toEqual(['Не то'])
    expect(await onHypothesisPress(d, { taskId: t?.id ?? '', action: 'drop' }, AT_1100)).toBe(
      'Уже отмечено',
    )
    const day = 86400000
    expect((await toldBefore(db, AT_1100)).get('a')?.silenced).toBe(true)
    expect((await toldBefore(db, new Date(AT_1100.getTime() + 31 * day))).get('a')?.silenced).toBe(
      false,
    )
  })

  it('FR-ANL: «Проверяем» keeps it as told, not silenced', async () => {
    await publish({ db, notifier }, 'post', [told('a')])
    const [t] = await db.select().from(task)
    await onHypothesisPress({ db }, { taskId: t?.id ?? '', action: 'want' }, AT_1100)
    const [h] = await db
      .select()
      .from(analyticsHypothesis)
      .where(eq(analyticsHypothesis.fingerprint, 'a'))
    expect(h?.status).toBe('checking')
    expect((await toldBefore(db, AT_1100)).get('a')).toEqual({ level: 'early', silenced: false })
  })

  it('FR-ANL: a run that only shows sends nothing and does not count as told', async () => {
    await publish({ db, notifier }, 'show', [told('a')])
    expect(sent).toEqual([])
    expect((await db.select().from(analyticsHypothesis))[0]?.status).toBe('preview')
    expect((await toldBefore(db, AT_1100)).size).toBe(0)
  })
})
