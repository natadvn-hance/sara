import { describe, expect, it } from 'vitest'
import { ClientInfo, GetOrderOutput } from '../src/contracts/profi'

describe('client info', () => {
  it('FR-LEAD-7: what the order page says about the client fits the contract', () => {
    const info = {
      name: 'Ирина',
      on_profi_since: 'На Профи.ру с 7 сентября 2020',
      phone_verified: true,
      reviews: { positive: 3, negative: 1 },
      review_tags: ['Перестала отвечать'],
    }
    expect(ClientInfo.parse(info)).toEqual(info)
    expect(ClientInfo.safeParse({ ...info, review_tags: Array(11).fill('x') }).success).toBe(false)
  })

  it('FR-LEAD-5: get_order may carry the client info, or none', () => {
    const order = {
      order_id: '1',
      title: 'Сайт',
      category: 'Сайты',
      city: 'Москва',
      text: 'Нужен сайт',
      client_name: 'Ирина',
      budget_text: null,
      bid_price_rub: 120,
      seen_at: '2026-10-25T08:00:00.000Z',
      open: true,
      published_at: null,
      has_bid: false,
    }
    expect(GetOrderOutput.parse(order).client_info).toBeUndefined()
    expect(GetOrderOutput.parse({ ...order, client_info: null }).client_info).toBeNull()
  })

  it('FR-LEAD-5: get_order says whether its numbers come from the order page read now', () => {
    const order = {
      order_id: '1',
      title: 'Сайт',
      category: 'Сайты',
      city: 'Москва',
      text: 'Нужен сайт',
      client_name: 'Ирина',
      budget_text: null,
      bid_price_rub: 120,
      seen_at: '2026-10-25T08:00:00.000Z',
      open: true,
      published_at: null,
      has_bid: false,
    }
    expect(GetOrderOutput.parse(order).from_page).toBeUndefined()
    expect(GetOrderOutput.parse({ ...order, from_page: true }).from_page).toBe(true)
    expect(GetOrderOutput.safeParse({ ...order, from_page: 'yes' }).success).toBe(false)
  })
})
