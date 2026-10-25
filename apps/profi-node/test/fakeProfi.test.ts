import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { signMessagePermit, signPermit } from '@sara/shared/permit'
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
      'profi.get_order',
      'profi.list_chats',
      'profi.list_feed',
      'profi.read_chat',
      'profi.send_message',
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

  it('FR-CONV-9: send_message repeats with one key give one message', async () => {
    const c = await mcp()
    const msg = {
      account_id: 'hance-marketing',
      chat_id: '95147898',
      text: 'Добрый день',
      expect_last_message_id: null,
      idempotency_key: 'msg:t:1',
      permit: signMessagePermit(SECRET, {
        accountId: 'hance-marketing',
        chatId: '95147898',
        text: 'Добрый день',
        key: 'msg:t:1',
      }),
    }
    const a = await c.callTool({ name: 'profi.send_message', arguments: msg })
    const b = await c.callTool({ name: 'profi.send_message', arguments: msg })
    expect(a.isError).toBeFalsy()
    expect(b.structuredContent).toEqual(a.structuredContent)
    expect(fake.messages).toHaveLength(1)
    const bad = await c.callTool({
      name: 'profi.send_message',
      arguments: { ...msg, permit: 'bad' },
    })
    expect(bad.isError).toBe(true)
    const other = await c.callTool({
      name: 'profi.send_message',
      arguments: { ...msg, text: 'Другой текст', idempotency_key: 'msg:t:2' },
    })
    expect(other.isError).toBe(true)
    expect(fake.messages).toHaveLength(1)
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

  it('FR-LEAD-5: get_order answers with the order the fake emitted, open and not bid on, and counts the read', async () => {
    await fake.emitOrder({ order_id: '801', bid_price_rub: 0, client_name: '' })
    const c = await mcp()
    const r = await c.callTool({
      name: 'profi.get_order',
      arguments: { account_id: 'hance-marketing', order_id: '801' },
    })
    expect(r.structuredContent).toMatchObject({
      order_id: '801',
      open: true,
      has_bid: false,
      bid_price_rub: 0,
    })
    expect(fake.orderReads).toEqual(['801'])
    await c.close()
  })

  it('FR-LEAD-5: a page set for the order shows its fee, client name, text and client info', async () => {
    await fake.emitOrder({ order_id: '802', bid_price_rub: 0, client_name: '', text: '' })
    const client_info = {
      name: 'Ирина',
      on_profi_since: 'На Профи.ру с 7 сентября 2020',
      phone_verified: true,
      reviews: { positive: 3, negative: 1 },
      review_tags: ['Перестала отвечать'],
    }
    fake.setOrderPage('802', {
      bid_price_rub: 145,
      client_name: 'Ирина',
      text: 'Полный текст',
      client_info,
    })
    const c = await mcp()
    const r = await c.callTool({
      name: 'profi.get_order',
      arguments: { account_id: 'hance-marketing', order_id: '802' },
    })
    expect(r.structuredContent).toMatchObject({
      bid_price_rub: 145,
      client_name: 'Ирина',
      text: 'Полный текст',
      client_info,
    })
    await c.close()
  })

  it('FR-LEAD-5: a page can be closed, bid on, failing, or slow', async () => {
    await fake.emitOrder({ order_id: '803' })
    const c = await mcp()
    const read = () =>
      c.callTool({
        name: 'profi.get_order',
        arguments: { account_id: 'hance-marketing', order_id: '803' },
      })
    fake.setOrderPage('803', { open: false })
    expect((await read()).structuredContent).toMatchObject({ open: false })
    fake.setOrderPage('803', { has_bid: true })
    expect((await read()).structuredContent).toMatchObject({ has_bid: true })
    fake.setOrderPage('803', { fail: 'LAYOUT_CHANGED' })
    const failed = await read()
    expect(failed.isError).toBe(true)
    fake.setOrderPage('803', { delayMs: 300 })
    const started = Date.now()
    await read()
    expect(Date.now() - started).toBeGreaterThanOrEqual(290)
    await c.close()
  })

  it('FR-LEAD-5: an order the fake never emitted is NOT_FOUND', async () => {
    const c = await mcp()
    const r = await c.callTool({
      name: 'profi.get_order',
      arguments: { account_id: 'hance-marketing', order_id: '999' },
    })
    expect(r.isError).toBe(true)
    await c.close()
  })
})
