import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ParseResult } from '../src/eyes/parsers'
import { profiParsers } from '../src/eyes/profiParsers'

// Anonymized records of the live site, 24.10.2026 (scripts/profi-samples.ts, plan M1 Task 15).
const ROOT = resolve(import.meta.dirname, '../../../tests/fixtures/profi')

type Sample = {
  kind: 'rtp' | 'response' | 'dom'
  url: string | null
  body: unknown
  receivedAt: string
}

const sample = (kind: Sample['kind'], name: string): Sample =>
  JSON.parse(readFileSync(join(ROOT, kind, `${name}.json`), 'utf8'))

const parse = (s: Sample): ParseResult =>
  s.kind === 'rtp' ? profiParsers.fromRtp(s.body) : profiParsers.fromResponse(s.url ?? '', s.body)

type BoardItem = { id: string; type: string }

describe('Profi.ru samples', () => {
  it('ST-M1-10: the board sample gives each order card as an order that waits for its page', () => {
    const s = sample('response', 'board')
    const r = parse(s)
    expect(r.recognized).toBe(true)
    expect(r.what).toBe('feed')
    const cards = (
      s.body as { data: { boSearchBoardItems: { items: BoardItem[] } } }
    ).data.boSearchBoardItems.items.filter((it) => it.type === 'SNIPPET')
    expect(cards.length).toBeGreaterThan(10)
    expect(r.signals.map((x) => (x.t === 'order' ? x.order.order_id : x.t))).toEqual(
      cards.map((c) => c.id),
    )
    for (const x of r.signals) {
      expect(x).toMatchObject({ t: 'order', needsPage: true, order: { bid_price_rub: 0 } })
      if (x.t === 'order') expect(Date.parse(x.published_at ?? '')).toBeGreaterThan(0)
    }
  })

  it('FR-LEAD-9: the profile sample gives the wallet balance', () => {
    expect(parse(sample('response', 'profile'))).toEqual({
      recognized: true,
      signals: [{ t: 'balance', rub: 23 }],
    })
  })

  it('FR-CONV-1: the order chat notice of the stream names the chat by its order number', () => {
    expect(parse(sample('rtp', 'chat-order-notify'))).toEqual({
      recognized: true,
      what: 'stream',
      signals: [{ t: 'chat_touched', chatId: '10000003', messageId: null }],
    })
  })

  it('FR-CONV-1: the unread notice of the stream names the chat and the new message', () => {
    expect(parse(sample('rtp', 'messenger-unread-notify'))).toEqual({
      recognized: true,
      what: 'stream',
      signals: [{ t: 'chat_touched', chatId: '10000005', messageId: '1000000003' }],
    })
  })

  it('ADR-002: the stream open frame, its greeting and a subscription answer are known and quiet', () => {
    for (const name of ['open', 'server-ready', 'subscription-ack'])
      expect(parse(sample('rtp', name))).toEqual({ recognized: true, what: 'stream', signals: [] })
  })

  it('ADR-002: an answer the readers do not know is not recognized', () => {
    expect(parse(sample('response', 'interface-data'))).toEqual({
      recognized: false,
      signals: [],
    })
  })

  it('ST-M1-06: the order page answer gives the fee for a bid and no order', () => {
    expect(parse(sample('response', 'order-page'))).toEqual({
      recognized: true,
      what: 'order',
      signals: [{ t: 'order_fee', orderId: '10000001', rub: 71, hasBid: false }],
    })
  })

  it('ST-M1-06: with a discount the fee is what the bid costs now, not the usual price', () => {
    // «Для вас отклик на этот заказ стоит 1 ₽»: the page text has no «Отклик • N ₽» line then.
    expect(parse(sample('response', 'order-page-discount')).signals).toEqual([
      { t: 'order_fee', orderId: '10000001', rub: 1, hasBid: false },
    ])
  })

  it('ADR-002: every stream and answer sample is read the way this file expects', () => {
    const unknown = new Set(['response/interface-data'])
    for (const kind of ['rtp', 'response'] as const) {
      for (const file of readdirSync(join(ROOT, kind))) {
        const name = `${kind}/${file.replace(/\.json$/, '')}`
        expect([name, parse(sample(kind, file.replace(/\.json$/, ''))).recognized]).toEqual([
          name,
          !unknown.has(name),
        ])
      }
    }
  })
})
