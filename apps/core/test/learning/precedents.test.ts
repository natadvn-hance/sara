import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { lead, leadLabel } from '../../src/db/schema'
import { forgetFormParts } from '../../src/leads/screen'
import {
  alike,
  forgetWordStats,
  PRECEDENTS_MAX,
  precedentsText,
  shareOf,
  similarDecisions,
  similarity,
  similarOnCard,
  statsOf,
  storePrecedents,
  weightsOf,
  wordsOf,
} from '../../src/learning/precedents'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  forgetFormParts()
  forgetWordStats()
})

/** A past order with Boris's decision on it. */
async function decided(
  id: string,
  title: string,
  text: string,
  label: 'yes' | 'no' | 'weak_no',
  o: { code?: string; by?: string; daysAgo?: number; account?: string } = {},
) {
  await db.insert(lead).values({
    id,
    accountId: o.account ?? 'hance-marketing',
    title,
    // On Profi.ru the category is the title (apps/profi-node/src/eyes/profiParsers.ts).
    category: title,
    city: 'Москва',
    text,
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
  title: 'Маркетолог',
  category: 'Маркетолог',
  text: 'Нужна маркетинговая стратегия для стоматологической клиники, анализ конкурентов и план продвижения',
}
const LIKE = 'Стратегия для стоматологической клиники, конкуренты и план на год'
const OTHER = 'Вести Instagram салона красоты, сторис и посты каждый день'
const NO_FORM = { parts: new Set<string>(), labels: new Set<string>() }

describe("Boris's decisions on similar orders (07.11.2026, stricter 10.11.2026)", () => {
  it('FR-LEAD-3: orders alike by the client words are similar; the same category alone is not', () => {
    const doc = (title: string, text: string) => wordsOf({ title, category: title, text }, NO_FORM)
    const mine = doc(NEW.title, NEW.text)
    const like = doc('Маркетолог', LIKE)
    const sameTitle = doc('Маркетолог', OTHER)
    // The orders of the month weigh the words: the title, in many of them, weighs little.
    const w = weightsOf(
      statsOf([
        mine,
        like,
        sameTitle,
        ...Array.from({ length: 30 }, () => doc('Маркетолог', OTHER)),
      ]),
    )
    const s = similarity(mine, like, w)
    expect(s.shared).toBeGreaterThanOrEqual(2)
    expect(s.score).toBeGreaterThan(0.2)
    expect(alike(s)).toBe(true)
    // The same title (the category on Profi.ru) and nothing of the client's words in common: not similar.
    expect(similarity(mine, sameTitle, w).shared).toBe(0)
    expect(alike(similarity(mine, sameTitle, w))).toBe(false)
  })

  it("FR-LEAD-3: the site's form is not the client's words: its parts and labels are not compared", () => {
    const form = {
      parts: new Set(['контент есть', 'разовая задача или временный проект']),
      labels: new Set(['бюджет на рекламную кампанию', 'сфера']),
    }
    const w = wordsOf(
      {
        title: 'Сайт',
        category: 'Сайт',
        text: 'Контент есть · Разовая задача или временный проект · Сфера: Стоматология · Бюджет на рекламную кампанию: 5000',
      },
      form,
    )
    expect([...w.own]).toEqual(['стомат'])
    expect([...w.all].sort()).toEqual(['сайт', 'стомат'])
  })

  it('FR-LEAD-3: a word in many orders of the month proves nothing, even shared; in a young database nothing is common', () => {
    const doc = (text: string) =>
      wordsOf({ title: 'Маркетинг', category: 'Маркетинг', text }, NO_FORM)
    const docs = Array.from({ length: 30 }, (_, i) => doc(`продвижение бизнеса клиентов ${i}`))
    const w = weightsOf(statsOf(docs))
    expect(w.common('продви')).toBe(true)
    expect(similarity(docs[0] as never, docs[1] as never, w).shared).toBe(0)
    expect(weightsOf(statsOf(docs.slice(0, 15))).common('продви')).toBe(false)
  })

  it('FR-LEAD-3: the most alike he decided himself; no ignored card, no other account, nothing older than 90 days, never the order itself', async () => {
    await decided('970001', 'Маркетолог', LIKE, 'no', { code: 'profile' })
    await decided('970002', 'Маркетолог', `${LIKE}, срочно`, 'yes')
    await decided('970003', 'Маркетолог', OTHER, 'no', { code: 'budget' })
    await decided('970004', 'Маркетолог', `${LIKE}.`, 'weak_no')
    await decided('970005', 'Маркетолог', `${LIKE}!`, 'no', { account: 'other' })
    await decided('970006', 'Маркетолог', `${LIKE}?`, 'no', { daysAgo: 100 })
    await decided('970000', NEW.title, NEW.text, 'no')
    const ps = await similarDecisions(db, 'hance-marketing', NEW)
    expect(ps.map((p) => p.leadId).sort()).toEqual(['970001', '970002'])
    expect(ps.find((p) => p.leadId === '970001')).toMatchObject({
      label: 'no',
      reason: { code: 'profile', detail: 'SMM ведение' },
      chosen: false,
      clientName: 'Тимур',
    })
  })

  it('FR-LEAD-3: at most 15, so the share stands on 10-15 decisions (Boris, 10.11.2026)', async () => {
    expect(PRECEDENTS_MAX).toBe(15)
    for (let i = 1; i <= 18; i++)
      await decided(`9701${String(i).padStart(2, '0')}`, 'Маркетолог', `${LIKE} ${i}`, 'yes')
    expect(await similarDecisions(db, 'hance-marketing', NEW)).toHaveLength(15)
  })

  it('FR-LEAD-3: the share of bids counts from the minimum on, exactly', () => {
    expect(shareOf(['yes', 'yes', 'no'], 10)).toEqual({ n: 3, bid: 2, pct: 67, enough: false })
    expect(shareOf([...Array(8).fill('yes'), 'no', 'no'], 10)).toEqual({
      n: 10,
      bid: 8,
      pct: 80,
      enough: true,
    })
    expect(shareOf([], 10)).toEqual({ n: 0, bid: 0, pct: 0, enough: false })
  })

  it('FR-LEAD-3: the card keeps the share, how many he closed, and the reason behind half of the closes or more', () => {
    const p = (
      id: string,
      label: 'yes' | 'no',
      reason: { code: 'profile' | 'budget'; detail: string | null } | null,
    ) => ({
      leadId: id,
      title: 'Т',
      category: 'SMM',
      clientName: '',
      label,
      reason,
      chosen: false,
    })
    const stored = storePrecedents([
      p('1', 'no', { code: 'profile', detail: 'SMM ведение' }),
      p('2', 'no', { code: 'profile', detail: 'SMM ведение' }),
      p('3', 'no', { code: 'profile', detail: 'дизайн' }),
      p('4', 'no', { code: 'budget', detail: null }),
      p('5', 'yes', null),
    ])
    expect(JSON.stringify(stored)).not.toContain('Т"')
    expect(similarOnCard(stored, 10)).toEqual({
      n: 5,
      bid: 1,
      pct: 20,
      min: 10,
      enough: false,
      closed: 4,
      reason: 'не наш профиль',
    })
    expect(similarOnCard(stored, 5)?.enough).toBe(true)
    expect(similarOnCard({ items: [] }, 10)).toBeNull()
    expect(similarOnCard(null, 10)).toBeNull()
  })

  it('FR-LEAD-3: the Scorer is told the share as the card says it, or that there are too few', () => {
    const p = (label: 'yes' | 'no') => ({
      leadId: '1',
      title: 'Стратегия клиники',
      category: 'Маркетолог',
      clientName: '',
      label,
      reason: null,
      chosen: false,
    })
    const ten = [...Array(9).fill(p('yes')), p('no')]
    expect(precedentsText(ten, 10).split('\n')[0]).toBe(
      'Решения Бориса по похожим заказам (его прошлые нажатия, самые похожие первыми): откликнулся на 9 из 10, это 90%.',
    )
    expect(precedentsText(ten.slice(0, 3), 10).split('\n')[0]).toBe(
      'Решения Бориса по похожим заказам (его прошлые нажатия, самые похожие первыми): откликнулся на 3 из 3; похожих меньше 10, доля ещё ничего не говорит.',
    )
    expect(precedentsText([], 10)).toBe('')
  })
})
