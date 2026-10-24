import { expect, it } from 'vitest'
import { signMessagePermit, signPermit, verifyMessagePermit, verifyPermit } from '../src/permit'

const bid = {
  idempotency_key: 'bid:123',
  order_id: '123',
  max_fee_rub: 210,
  not_after: '2026-10-25T12:00:00.000Z',
}

it('C2: permit verifies only for its own key', () => {
  const p = signPermit('s', bid)
  expect(verifyPermit('s', { ...bid, permit: p })).toBe(true)
  expect(verifyPermit('s', { ...bid, idempotency_key: 'bid:124', permit: p })).toBe(false)
  expect(verifyPermit('other', { ...bid, permit: p })).toBe(false)
})

it('C2: permit covers the order, the most the bid may cost and its deadline', () => {
  const p = signPermit('s', bid)
  expect(verifyPermit('s', { ...bid, order_id: '124', permit: p })).toBe(false)
  expect(verifyPermit('s', { ...bid, max_fee_rub: 211, permit: p })).toBe(false)
  expect(verifyPermit('s', { ...bid, not_after: '2026-10-25T12:00:01.000Z', permit: p })).toBe(
    false,
  )
  expect(verifyPermit('s', { ...bid, permit: 'zz' })).toBe(false)
})

it('FR-CONV-9: a message permit holds the account, the chat, the text and the key', () => {
  const m = { accountId: 'a', chatId: 'c', text: 'Добрый день', key: 'msg:t:1' }
  const p = signMessagePermit('s', m)
  expect(verifyMessagePermit('s', m, p)).toBe(true)
  expect(verifyMessagePermit('s', { ...m, text: 'Другое' }, p)).toBe(false)
  expect(verifyMessagePermit('s', { ...m, chatId: 'd' }, p)).toBe(false)
  const asBid = { ...bid, idempotency_key: 'msg:t:1', order_id: 'c' }
  expect(verifyMessagePermit('s', m, signPermit('s', asBid))).toBe(false)
  expect(verifyPermit('s', { ...asBid, permit: p })).toBe(false)
})
