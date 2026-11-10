import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead, leadLabel } from '../../src/db/schema'
import { appendEvent } from '../../src/journal/journal'
import {
  historyReport,
  loadShadows,
  reportText,
  type ShadowRow,
  weekReport,
} from '../../src/leads/autobidReport'
import { type AutobidRule, shadowPayload } from '../../src/leads/autobidShadow'
import { forgetFormParts } from '../../src/leads/screen'
import { forgetWordStats } from '../../src/learning/precedents'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  forgetFormParts()
  forgetWordStats()
})

const RULE: AutobidRule = { minSimilar: 10, minSharePct: 80, maxFeeRub: 200 }
const row = (o: Partial<ShadowRow>): ShadowRow => ({
  leadId: '1',
  would: false,
  misses: [],
  n: 10,
  bid: 9,
  feeRub: 150,
  feeFromPage: true,
  rule: RULE,
  outcome: 'waiting',
  ...o,
})
const TEXT = (k: number) =>
  `Маркетинговая стратегия для стоматологической клиники, конкуренты и план продвижения. Филиал ${k}.`

async function order(
  id: string,
  label: 'yes' | 'no' | 'weak_no' | null,
  daysAgo = 1,
  text = TEXT(0),
) {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
  await db.insert(lead).values({
    id,
    accountId: 'hance-marketing',
    title: 'Маркетолог',
    category: 'Маркетолог',
    city: 'Москва',
    text,
    clientName: 'Вера',
    budgetText: null,
    bidPriceRub: 150,
    seenAt: at,
    status: 'queued',
    correlationId: newEventId(),
  })
  if (label) await db.insert(leadLabel).values({ leadId: id, label, source: 'card', at })
}

async function shadow(id: string, payload: object, daysAgo = 1) {
  await appendEvent(db, {
    type: 'lead.autobid_shadow',
    v: 1,
    entity: { kind: 'lead', id },
    account_id: 'hance-marketing',
    actor: 'sara',
    occurred_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: payload as Record<string, unknown>,
  })
}

describe('how the shadow of the auto-bid agreed with Boris (10.11.2026)', () => {
  it('FR-LEAD-9: the marked cards he bid on or closed, the unmarked he bid on, and why they were not marked', () => {
    const w = weekReport(
      [
        row({ would: true, outcome: 'bid' }),
        row({ would: true, outcome: 'closed' }),
        row({ would: true, outcome: 'waiting' }),
        row({ would: false, misses: ['few_similar'], n: 6, bid: 6, outcome: 'bid' }),
        row({ would: false, misses: ['low_share'], bid: 5, outcome: 'closed' }),
        row({ would: false, misses: ['fee_high'], feeRub: 300, outcome: 'stale' }),
      ],
      7,
    )
    expect(w.cards).toBe(6)
    expect(w.marked).toEqual({ n: 3, bid: 1, closed: 1, stale: 0, waiting: 1 })
    expect(w.unmarked).toEqual({ n: 3, bid: 1, closed: 1, stale: 1, waiting: 0 })
    // Agreed: the marked he bid on and the unmarked he closed; of four he decided.
    expect([w.agree, w.decided]).toEqual([2, 4])
    expect(w.misses).toMatchObject({ few_similar: 1, low_share: 1, fee_high: 1 })
    // With five similar orders enough, the six-of-six one would have been marked too.
    expect(w.byMin.find((b) => b.min === 5)?.marked).toMatchObject({ n: 4, bid: 2 })
  })

  it('FR-LEAD-9: the journal gives each card once, with his decision; test orders do not count', async () => {
    await order('94000001', 'yes')
    await order('94000002', 'no')
    await order('94000003', null)
    await order('99000000001', 'yes')
    await shadow('94000001', shadowPayload({ n: 10, bid: 9 }, { rub: 150, fromPage: true }, RULE))
    // A card rebuilt later journals nothing new, but a second event of one lead counts once, the first.
    await shadow(
      '94000001',
      shadowPayload({ n: 2, bid: 0 }, { rub: 0, fromPage: false }, RULE),
      0.5,
    )
    await shadow('94000002', shadowPayload({ n: 10, bid: 5 }, { rub: 150, fromPage: true }, RULE))
    await shadow('94000003', shadowPayload({ n: 3, bid: 3 }, { rub: 150, fromPage: false }, RULE))
    await shadow('99000000001', shadowPayload({ n: 10, bid: 10 }, { rub: 1, fromPage: true }, RULE))
    await shadow('94000004', shadowPayload({ n: 10, bid: 10 }, { rub: 1, fromPage: true }, RULE), 9)
    const rows = await loadShadows(db, 7)
    expect(rows.map((r) => [r.leadId, r.would, r.outcome]).sort()).toEqual([
      ['94000001', true, 'bid'],
      ['94000002', false, 'closed'],
      ['94000003', false, 'waiting'],
    ])
    expect(rows.find((r) => r.leadId === '94000003')?.misses).toEqual([
      'few_similar',
      'fee_not_fresh',
    ])
  })

  it('FR-LEAD-9: over his past decisions: how many had ten similar before them, and what the rule would have caught', async () => {
    // Eleven bids on alike orders, then a twelfth he bid on and a thirteenth he closed: both had ten and more before.
    for (let i = 0; i < 11; i++)
      await order(`941000${String(i).padStart(2, '0')}`, 'yes', 40 - i, TEXT(i))
    await order('94200001', 'yes', 5, TEXT(50))
    await order('94200002', 'no', 4, TEXT(51))
    // Something else entirely, with nothing like it before.
    await order('94200003', 'no', 3, 'Вести Instagram салона красоты, сторис каждый день')
    const h = await historyReport(db, 'hance-marketing', RULE, 30)
    expect(h.decisions).toBe(3)
    expect(h.bids).toBe(1)
    expect(h.bySimilar).toEqual({ none: 1, few: 0, some: 0, enough: 2 })
    expect(h.byMin.find((m) => m.min === 10)).toEqual({ min: 10, fired: 2, bid: 1, closed: 1 })
  })

  it('FR-LEAD-9: the report is one plain message of numbers: no client words, no long dash', () => {
    const text = reportText(
      weekReport(
        [row({ would: true, outcome: 'bid' }), row({ outcome: 'closed', misses: ['few_similar'] })],
        7,
      ),
      {
        days: 30,
        decisions: 40,
        bids: 9,
        bySimilar: { none: 20, few: 10, some: 6, enough: 4 },
        byMin: [{ min: 10, fired: 3, bid: 2, closed: 1 }],
      },
      RULE,
    )
    expect(text).toContain(
      '🤖 Помечено 1: ты откликнулся на 1, закрыл 0, пропустил 0, ещё не решил 0.',
    )
    expect(text).toContain('Совпадение с тобой: 2 из 2 решённых (100%).')
    expect(text).toContain('Почему без пометки: мало похожих 1.')
    expect(text).toContain(
      'Минимум 10: сработало бы на 3, из них ты откликнулся на 2, закрыл 1; поймало бы 2 из 9 твоих откликов.',
    )
    expect(text).not.toContain(String.fromCharCode(0x2014))
  })
})
