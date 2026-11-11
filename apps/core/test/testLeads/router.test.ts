import { describe, expect, it } from 'vitest'
import { type ProfiClient, ProfiError } from '../../src/profi/client'
import { guardLive, routeTestOrders } from '../../src/testLeads/router'

// Test orders inside the live Sara (docs/ops/test-leads.md): the core's own lock before the node's.
const TEST = '99000000001'
const REAL = '95147898'

function spy(name: string, calls: string[]): ProfiClient {
  const note = <T>(what: string, out: T): T => {
    calls.push(`${name}:${what}`)
    return out
  }
  const chat = {
    chat_id: name === 'live' ? REAL : TEST,
    order_id: null,
    last_message_at: null,
    unread: 0,
  }
  return {
    sessionHealth: async () =>
      note('health', { alive: true, balance_rub: 23, presence: true, egress_ip: null }),
    getOrder: async (_a, id) => note(`get:${id}`, {} as never),
    submitBid: async (i) => note(`bid:${i.order_id}`, {} as never),
    readChat: async (_a, c) => note(`read:${c}`, { messages: [] }),
    listChats: async () => note('list', { chats: [chat] }),
    sendMessage: async (i) => note(`send:${i.chat_id}`, {} as never),
  }
}

const bid = (order_id: string) => ({
  account_id: 'hance-marketing',
  order_id,
  text: 'Добрый день!',
  max_fee_rub: 210,
  idempotency_key: `bid:${order_id}`,
})
const message = (chat_id: string) => ({
  account_id: 'hance-marketing',
  chat_id,
  text: 'Добрый день!',
  expect_last_message_id: null,
  idempotency_key: `msg:${chat_id}`,
})

describe('the Profi client of the core and test orders', () => {
  it('FR-LEAD-9: the node client refuses a test order before calling the node, a real one passes', async () => {
    const calls: string[] = []
    const node = guardLive(spy('live', calls))
    for (const attempt of [
      () => node.getOrder('hance-marketing', TEST),
      () => node.submitBid(bid(TEST)),
      () => node.readChat('hance-marketing', TEST),
      () => node.sendMessage(message(TEST)),
    ]) {
      const e = await attempt().catch((x: unknown) => x)
      expect(e).toBeInstanceOf(ProfiError)
      expect((e as ProfiError).errorClass).toBe('NOT_FOUND')
    }
    expect(calls).toEqual([])
    await node.submitBid(bid(REAL))
    expect(calls).toEqual([`live:bid:${REAL}`])
  })

  it('FR-LEAD-9: a test order and its chat go to the made-up Profi.ru, the rest to the node, the chat list is both', async () => {
    const calls: string[] = []
    const profi = routeTestOrders(spy('live', calls), () => spy('test', calls))
    await profi.getOrder('hance-marketing', TEST)
    await profi.submitBid(bid(TEST))
    await profi.readChat('hance-marketing', TEST)
    await profi.sendMessage(message(TEST))
    await profi.submitBid(bid(REAL))
    await profi.sendMessage(message(REAL))
    await profi.sessionHealth('hance-marketing')
    expect(calls).toEqual([
      `test:get:${TEST}`,
      `test:bid:${TEST}`,
      `test:read:${TEST}`,
      `test:send:${TEST}`,
      `live:bid:${REAL}`,
      `live:send:${REAL}`,
      'live:health',
    ])
    expect((await profi.listChats('hance-marketing')).chats.map((c) => c.chat_id)).toEqual([
      REAL,
      TEST,
    ])
  })

  it('NFR-UX-1: a test order’s chat gets the text a real client would: plain quotes, no «ё», Boris’s own quotes kept (11.11.2026)', async () => {
    const sent: string[] = []
    const made: ProfiClient = {
      ...spy('test', []),
      sendMessage: async (i) => {
        sent.push(i.text)
        return {} as never
      },
      submitBid: async (i) => {
        sent.push(i.text)
        return {} as never
      },
    }
    const profi = routeTestOrders(spy('live', []), () => made)
    await profi.sendMessage({ ...message(TEST), text: 'Её «лендинг»' })
    await profi.sendMessage({ ...message(TEST), text: 'Её «лендинг»', asWritten: true })
    await profi.submitBid({ ...bid(TEST), text: 'Её «лендинг»' })
    expect(sent).toEqual(['Ее "лендинг"', 'Ее «лендинг»', 'Ее "лендинг"'])
  })

  it('FR-LEAD-9: with the made-up Profi.ru not running a test order fails, and still never reaches the node', async () => {
    const calls: string[] = []
    const profi = routeTestOrders(spy('live', calls), () => null)
    const e = await profi.submitBid(bid(TEST)).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ProfiError)
    expect(calls).toEqual([])
    expect((await profi.listChats('hance-marketing')).chats.map((c) => c.chat_id)).toEqual([REAL])
  })
})
