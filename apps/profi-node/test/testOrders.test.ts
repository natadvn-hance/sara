import { describe, expect, it } from 'vitest'
import { ProfiToolError, type ProfiToolsImpl } from '../src/mcp/server'
import { refuseTestOrders } from '../src/mcp/testOrders'

// The live node's own lock (docs/ops/test-leads.md): a test order never moves a tab on the real Profi.ru.
const TEST = '99000000001'
const REAL = '95147898'

function spyTools() {
  const calls: string[] = []
  const tools = {
    sessionHealth: async () => ({ alive: true, balance_rub: 23, presence: true, egress_ip: null }),
    listFeed: async () => ({ orders: [] }),
    getOrder: async (i: { order_id: string }) => {
      calls.push(`get:${i.order_id}`)
      return {} as never
    },
    listChats: async () => ({ chats: [] }),
    readChat: async (i: { chat_id: string }) => {
      calls.push(`read:${i.chat_id}`)
      return { messages: [] }
    },
    submitBid: async (i: { order_id: string }) => {
      calls.push(`bid:${i.order_id}`)
      return {} as never
    },
    sendMessage: async (i: { chat_id: string }) => {
      calls.push(`send:${i.chat_id}`)
      return {} as never
    },
  } as unknown as ProfiToolsImpl
  return { tools: refuseTestOrders(tools), calls }
}

describe('the live node and test orders', () => {
  it('FR-LEAD-9: a test order or chat is refused before any tool runs, a real one passes', async () => {
    const { tools, calls } = spyTools()
    const base = { account_id: 'hance-marketing' }
    const attempts = [
      () => tools.getOrder({ ...base, order_id: TEST }),
      () => tools.readChat({ ...base, chat_id: TEST }),
      () =>
        tools.submitBid({
          ...base,
          order_id: TEST,
          text: 'x',
          max_fee_rub: 1,
          not_after: new Date().toISOString(),
          idempotency_key: 'k',
          permit: 'p',
        }),
      () =>
        tools.sendMessage({
          ...base,
          chat_id: TEST,
          text: 'x',
          expect_last_message_id: null,
          idempotency_key: 'k',
          permit: 'p',
        }),
    ]
    for (const a of attempts) {
      const e = await a().catch((x: unknown) => x)
      expect(e).toBeInstanceOf(ProfiToolError)
      expect((e as ProfiToolError).errorClass).toBe('NOT_FOUND')
    }
    expect(calls).toEqual([])
    await tools.getOrder({ ...base, order_id: REAL })
    await tools.readChat({ ...base, chat_id: REAL })
    expect(calls).toEqual([`get:${REAL}`, `read:${REAL}`])
  })
})
