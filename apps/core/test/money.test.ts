import { formatRub, newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { outbox } from '../src/db/schema'
import { appendEvent } from '../src/journal/journal'
import { readWallet, refuseSpend } from '../src/leads/money'
import { setSetting } from '../src/settings/store'
import { openTestDb, resetDb } from './helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

// 25.10.2026 15:00 in Moscow (UTC+3).
const NOW = new Date('2026-10-25T12:00:00Z')

/** A bid confirmed at `at`, as the outbox journals it: bid.sent and spend.recorded. */
async function sentBid(at: string, spent: number): Promise<void> {
  const leadId = newEventId()
  const correlation = newEventId()
  for (const [type, payload] of [
    ['bid.sent', { spent_rub: spent }],
    ['spend.recorded', { amount_rub: spent, balance_after_rub: null }],
  ] as const) {
    await appendEvent(db, {
      type,
      v: 1,
      entity: { kind: 'lead', id: leadId },
      account_id: 'hance-marketing',
      actor: 'sara',
      occurred_at: at,
      causation_id: null,
      correlation_id: correlation,
      reason: null,
      payload,
    })
  }
}

/** A bid in the outbox in `state`, recorded at `at`. */
async function bidInOutbox(priceRub: number, state = 'queued', at = NOW.toISOString()) {
  const leadId = newEventId()
  await db.insert(outbox).values({
    id: newEventId(),
    kind: 'bid',
    idempotencyKey: `bid:${leadId}`,
    payload: { leadId, accountId: 'hance-marketing', priceRub },
    state,
    createdAt: at,
  })
}

const check = (feeRub: number, balanceRub: number | null = 5000) =>
  refuseSpend(db, { feeRub, balanceRub, now: NOW })

describe('spend check', () => {
  it('FR-LEAD-9: a bid within every limit is allowed', async () => {
    await sentBid('2026-10-25T08:00:00Z', 210)
    expect(await check(210)).toBeNull()
  })

  it('FR-LEAD-9: an unknown wallet refuses the bid', async () => {
    expect(await check(210, null)).toBe(
      'Не вижу баланс кошелька на Профи.ру, отклик не отправила. Нажми ещё раз через минуту.',
    )
  })

  it('FR-LEAD-9: a fee above the ceiling refuses the bid', async () => {
    await setSetting(db, 'money.max_fee_rub', 200, 'boris')
    expect(await check(210)).toBe(
      `Отклик стоит ${formatRub(210)}, это выше потолка ${formatRub(200)} за отклик. Отклик не отправила.`,
    )
    expect(await check(200)).toBeNull()
  })

  it('FR-LEAD-9: the wallet must cover the fee after the bids still in the queue', async () => {
    await bidInOutbox(300)
    // Failed and confirmed bids are no longer waiting for the wallet.
    await bidInOutbox(300, 'failed')
    expect(await check(210, 500)).toBe(
      `На кошельке ${formatRub(200)} за вычетом откликов в очереди, а отклик стоит ${formatRub(210)}. Пополни кошелёк и нажми снова.`,
    )
    expect(await check(200, 500)).toBeNull()
  })

  it('FR-LEAD-9: a wallet below the fee refuses the bid', async () => {
    expect(await check(210, 100)).toBe(
      `На кошельке ${formatRub(100)}, а отклик стоит ${formatRub(210)}. Пополни кошелёк и нажми снова.`,
    )
  })

  it("FR-LEAD-9: the day's spend with the fee must stay within the budget", async () => {
    await setSetting(db, 'money.daily_budget_rub', 500, 'boris')
    await sentBid('2026-10-25T08:00:00Z', 210)
    expect(await check(300)).toBe(
      `Бюджет дня ${formatRub(500)}: уже ${formatRub(210)}, отклик стоит ${formatRub(300)}. Отклик не отправила.`,
    )
    expect(await check(290)).toBeNull()
  })

  it('FR-LEAD-9: a bid in the queue counts toward the budget and the cap', async () => {
    await setSetting(db, 'money.daily_budget_rub', 500, 'boris')
    await bidInOutbox(300)
    expect(await check(210)).toBe(
      `Бюджет дня ${formatRub(500)}: уже ${formatRub(300)}, отклик стоит ${formatRub(210)}. Отклик не отправила.`,
    )
    await setSetting(db, 'money.daily_budget_rub', null, 'boris')
    await setSetting(db, 'money.daily_bids', 1, 'boris')
    expect(await check(210)).toBe(
      'Сегодня уже 1 отклик из 1, это дневной лимит. Отклик не отправила.',
    )
  })

  it("FR-LEAD-9: the day's bid cap refuses the next bid", async () => {
    await setSetting(db, 'money.daily_bids', 2, 'boris')
    await sentBid('2026-10-25T08:00:00Z', 210)
    // A bid that may have gone out is counted; a failed one spent nothing.
    await bidInOutbox(210, 'uncertain')
    await bidInOutbox(210, 'failed')
    expect(await check(210)).toBe(
      'Сегодня уже 2 отклика из 2, это дневной лимит. Отклик не отправила.',
    )
  })

  it('FR-LEAD-9: two presses at once cannot both pass the cap', async () => {
    await setSetting(db, 'money.daily_bids', 1, 'boris')
    // Each press checks and then records its bid in one transaction, as onPress does.
    const press = () =>
      db.transaction(async (tx) => {
        const refusal = await refuseSpend(tx, { feeRub: 210, balanceRub: 5000, now: new Date() })
        if (refusal) return refusal
        await new Promise((r) => setTimeout(r, 150))
        const leadId = newEventId()
        await tx.insert(outbox).values({
          id: newEventId(),
          kind: 'bid',
          idempotencyKey: `bid:${leadId}`,
          payload: { leadId, accountId: 'hance-marketing', priceRub: 210 },
        })
        return null
      })
    const results = await Promise.all([press(), press()])
    expect(results.filter((r) => r === null)).toHaveLength(1)
  })

  it('FR-LEAD-9: the day is the Moscow day', async () => {
    await setSetting(db, 'money.daily_bids', 1, 'boris')
    await setSetting(db, 'money.daily_budget_rub', 300, 'boris')
    // 24.10 at 23:00 Moscow time: yesterday, together with yesterday's unsure bid.
    await sentBid('2026-10-24T20:00:00Z', 210)
    await bidInOutbox(210, 'uncertain', '2026-10-24T20:30:00Z')
    expect(await check(210)).toBeNull()
    // 25.10 at 00:30 Moscow time: already today.
    await sentBid('2026-10-24T21:30:00Z', 210)
    expect(await check(10)).toBe(
      'Сегодня уже 1 отклик из 1, это дневной лимит. Отклик не отправила.',
    )
  })

  it('FR-LEAD-9: the wallet is read from the session health, unknown when the node does not answer', async () => {
    const health = (balance_rub: number | null) => async () => ({
      alive: true,
      balance_rub,
      presence: true,
      egress_ip: null,
    })
    expect(await readWallet({ sessionHealth: health(740) }, 'hance-marketing')).toBe(740)
    expect(await readWallet({ sessionHealth: health(null) }, 'hance-marketing')).toBeNull()
    const down = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    expect(await readWallet({ sessionHealth: down }, 'hance-marketing')).toBeNull()
  })
})
