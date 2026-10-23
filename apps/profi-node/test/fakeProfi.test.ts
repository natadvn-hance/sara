import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { signPermit } from '@sara/shared/permit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeProfi, type FakeProfi } from '../src/fake/fakeProfi'

const SECRET = 'test-permit'
let fake: FakeProfi
let received: unknown[]
let core: ReturnType<typeof createServer>

beforeEach(async () => {
  received = []
  core = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      received.push({ token: req.headers['x-sara-node-token'], body: JSON.parse(body) })
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"accepted":true,"duplicate":false}')
    })
  })
  await new Promise<void>((r) => core.listen(0, '127.0.0.1', r))
  const port = (core.address() as { port: number }).port
  fake = await createFakeProfi({
    port: 0,
    coreEventsUrl: `http://127.0.0.1:${port}/internal/profi/events`,
    nodeToken: 'node-tok',
    permitSecret: SECRET,
  })
})
afterEach(async () => {
  await fake.close()
  core.close()
})

async function mcp() {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(fake.url)))
  return client
}

const bid = (key = 'bid:1') => ({
  account_id: 'hance-marketing',
  order_id: '1',
  text: 'Добрый день!',
  idempotency_key: key,
  permit: signPermit(SECRET, key),
})

describe('fake Profi-MCP', () => {
  it('C2: fake tools match the contract names and schemas', async () => {
    const c = await mcp()
    const tools = await c.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'profi.session_health',
      'profi.submit_bid',
    ])
    expect(tools.tools.find((t) => t.name === 'profi.submit_bid')?.inputSchema.required).toContain(
      'permit',
    )
    await c.close()
  })

  it('C2: repeated idempotency_key returns the first result and records one bid', async () => {
    const c = await mcp()
    const a = await c.callTool({ name: 'profi.submit_bid', arguments: bid() })
    const b = await c.callTool({ name: 'profi.submit_bid', arguments: bid() })
    expect(b.structuredContent).toEqual(a.structuredContent)
    expect(fake.bids).toHaveLength(1)
    await c.close()
  })

  it('C2: submit_bid without a valid permit is refused', async () => {
    const c = await mcp()
    const r = await c.callTool({ name: 'profi.submit_bid', arguments: { ...bid(), permit: 'bad' } })
    expect(r.isError).toBe(true)
    expect(fake.bids).toHaveLength(0)
    await c.close()
  })

  it('C8: emitOrder delivers a profi.order_seen envelope with the node token', async () => {
    const id = await fake.emitOrder({ order_id: '777' })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      token: 'node-tok',
      body: { id, type: 'profi.order_seen', actor: 'profi', payload: { order_id: '777' } },
    })
  })
})
