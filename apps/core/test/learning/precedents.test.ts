import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead, leadLabel } from '../../src/db/schema'
import {
  similarDecisions,
  similarity,
  similarOnCard,
  storePrecedents,
} from '../../src/learning/precedents'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
})

/** A past order with Boris's decision on it. */
async function decided(
  id: string,
  title: string,
  category: string,
  label: 'yes' | 'no' | 'weak_no',
  o: { code?: string; by?: string; daysAgo?: number; account?: string } = {},
) {
  await db.insert(lead).values({
    id,
    accountId: o.account ?? 'hance-marketing',
    title,
    category,
    city: 'Москва',
    text: `${title}. Подробности`,
    clientName: 'Тимур',
    budgetText: null,
    bidPriceRub: 200,
    seenAt: new Date().toISOString(),
    status: 'skipped',
    correlationId: newEventId(),
  })
  await db.insert(leadLabel).values({
    leadId: id,
    label,
    source: label === 'weak_no' ? 'ignored' : 'card',
    reasonCode: o.code ?? null,
    reasonDetail: o.code === 'profile' ? 'SMM ведение' : null,
    reasonBy: o.code ? (o.by ?? 'guess') : null,
    at: new Date(Date.now() - (o.daysAgo ?? 1) * 86_400_000).toISOString(),
  })
}

const NEW = {
  orderId: '970000',
  title: 'Ведение Instagram для салона красоты',
  category: 'SMM',
  text: 'Нужно вести Instagram салона красоты',
}

describe("Boris's decisions on similar orders (07.11.2026)", () => {
  it('orders about the same thing are alike, others are not', () => {
    const smm = { title: 'Ведение Instagram для кофейни', category: 'SMM', text: '' }
    expect(similarity(NEW, smm)).toBeGreaterThan(0.5)
    expect(
      similarity(NEW, { title: 'Стратегия для клиники', category: 'Маркетинг', text: '' }),
    ).toBeLessThan(0.3)
  })

  it('the most alike he decided himself, newest first among equals; no ignored card, no other account, nothing older than 90 days', async () => {
    await decided('970001', 'Ведение Instagram для кофейни', 'SMM', 'no', { code: 'profile' })
    await decided('970002', 'Ведение Instagram для салона', 'SMM', 'yes')
    await decided('970003', 'Стратегия для клиники', 'Маркетинг', 'no', { code: 'budget' })
    await decided('970004', 'Ведение Instagram для салона красоты', 'SMM', 'weak_no')
    await decided('970005', 'Ведение Instagram для салона красоты', 'SMM', 'no', {
      account: 'other',
    })
    await decided('970006', 'Ведение Instagram для салона красоты', 'SMM', 'no', { daysAgo: 100 })
    await decided('970000', 'Ведение Instagram для салона красоты', 'SMM', 'no')
    const ps = await similarDecisions(db, 'hance-marketing', NEW)
    expect(ps.map((p) => p.leadId)).toEqual(['970002', '970001'])
    expect(ps[1]).toMatchObject({
      label: 'no',
      reason: { code: 'profile', detail: 'SMM ведение' },
      chosen: false,
      clientName: 'Тимур',
    })
  })

  it('at most five', async () => {
    for (let i = 1; i <= 7; i++)
      await decided(`97010${i}`, 'Ведение Instagram для салона', 'SMM', 'no', { code: 'profile' })
    expect(await similarDecisions(db, 'hance-marketing', NEW)).toHaveLength(5)
  })

  it('the card line: how many he closed, and the reason when it stands behind half of them or more', () => {
    const stored = storePrecedents([
      ...['1', '2', '3'].map((id) => ({
        leadId: id,
        title: 'Т',
        category: 'SMM',
        clientName: '',
        label: 'no' as const,
        reason: { code: 'profile' as const, detail: id === '3' ? 'дизайн' : 'SMM ведение' },
        chosen: false,
      })),
      {
        leadId: '4',
        title: 'Т',
        category: 'SMM',
        clientName: '',
        label: 'no' as const,
        reason: { code: 'budget' as const, detail: null },
        chosen: true,
      },
      {
        leadId: '5',
        title: 'Т',
        category: 'SMM',
        clientName: '',
        label: 'yes' as const,
        reason: null,
        chosen: false,
      },
    ])
    expect(JSON.stringify(stored)).not.toContain('Т"')
    expect(similarOnCard(stored)).toEqual({ n: 5, closed: 4, bid: 1, reason: 'не наш профиль' })
    expect(similarOnCard({ items: stored.items.slice(0, 1) })).toBeNull()
    expect(similarOnCard(null)).toBeNull()
  })
})
