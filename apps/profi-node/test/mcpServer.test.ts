import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { serveMcp } from '../src/mcp/http'
import { createProfiMcpServer, type ProfiToolsImpl } from '../src/mcp/server'

let close: (() => Promise<void>) | null = null
afterEach(async () => {
  await close?.()
  close = null
})

const notUsed = async (): Promise<never> => {
  throw new Error('not used')
}

describe('the MCP server of Profi-MCP (C2)', () => {
  it('NFR-REL-4: when the core stops waiting for submit_bid, the node hears it', async () => {
    let heard: AbortSignal | undefined
    let aborted = false
    const impl: ProfiToolsImpl = {
      sessionHealth: notUsed,
      listFeed: notUsed,
      getOrder: notUsed,
      listChats: notUsed,
      readChat: notUsed,
      sendMessage: notUsed,
      submitBid: (_i, signal) =>
        new Promise((_ok, no) => {
          heard = signal
          signal?.addEventListener('abort', () => {
            aborted = true
            no(new Error('cancelled'))
          })
        }),
    }
    const svc = await serveMcp(() => createProfiMcpServer(impl), 0)
    close = svc.close
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(svc.url)))
    const call = client.callTool(
      {
        name: 'profi.submit_bid',
        arguments: {
          account_id: 'hance-marketing',
          order_id: '1',
          text: 'Добрый день!',
          max_fee_rub: 210,
          not_after: new Date(Date.now() + 60_000).toISOString(),
          idempotency_key: 'bid:1',
          permit: 'p',
        },
      },
      undefined,
      { timeout: 300 },
    )
    await expect(call).rejects.toThrow()
    await client.close()
    const end = Date.now() + 3000
    while (!aborted && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    expect(heard).toBeDefined()
    expect(aborted).toBe(true)
  })
})
