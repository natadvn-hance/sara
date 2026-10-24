import { expect, it } from 'vitest'
import { signMessagePermit, signPermit, verifyMessagePermit, verifyPermit } from '../src/permit'

it('C2: permit verifies only for its own key', () => {
  const p = signPermit('s', 'bid:123')
  expect(verifyPermit('s', 'bid:123', p)).toBe(true)
  expect(verifyPermit('s', 'bid:124', p)).toBe(false)
  expect(verifyPermit('other', 'bid:123', p)).toBe(false)
})

it('FR-CONV-9: a message permit holds the account, the chat, the text and the key', () => {
  const m = { accountId: 'a', chatId: 'c', text: 'Добрый день', key: 'msg:t:1' }
  const p = signMessagePermit('s', m)
  expect(verifyMessagePermit('s', m, p)).toBe(true)
  expect(verifyMessagePermit('s', { ...m, text: 'Другое' }, p)).toBe(false)
  expect(verifyMessagePermit('s', { ...m, chatId: 'd' }, p)).toBe(false)
  expect(verifyMessagePermit('s', m, signPermit('s', 'msg:t:1'))).toBe(false)
  expect(verifyPermit('s', 'msg:t:1', p)).toBe(false)
})
