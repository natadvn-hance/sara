import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { EventEnvelope, PROFI_EVENT_PAYLOADS, type ProfiEventType } from '@sara/shared'
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

const bid = (key = 'bid:1') => {
  const unsigned = {
    account_id: 'hance-marketing',
    order_id: '1',
    text: 'Добрый день!',
    max_fee_rub: 210,
    not_after: new Date(Date.now() + 60_000).toISOString(),
    idempotency_key: key,
  }
  return { ...unsigned, permit: signPermit(SECRET, unsigned) }
}

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

  const send = (chatId: string, text: string, key: string, expect: string | null) => ({
    account_id: 'hance-marketing',
    chat_id: chatId,
    text,
    expect_last_message_id: expect,
    idempotency_key: key,
    permit: signMessagePermit(SECRET, { accountId: 'hance-marketing', chatId, text, key }),
  })
  const bodies = () => received.map((r) => (r as { body: EventEnvelope }).body)
  // Every event is a valid envelope whose payload is exactly the contract's (strict, no text).
  const checked = () =>
    bodies().map((b) => {
      const e = EventEnvelope.parse(b)
      expect(PROFI_EVENT_PAYLOADS[e.type as ProfiEventType].parse(e.payload)).toEqual(e.payload)
      return e
    })
  const readChat = async (c: Client, chatId: string) =>
    (
      (
        await c.callTool({
          name: 'profi.read_chat',
          arguments: { account_id: 'hance-marketing', chat_id: chatId },
        })
      ).structuredContent as { messages: Record<string, unknown>[] }
    ).messages

  it('FR-CONV-1: a chat message is kept and shipped as the event of its author without text', async () => {
    const before = new Date().toISOString()
    const client = await fake.addChatMessage({
      chatId: '95300020',
      orderId: '95300020',
      author: 'client',
      text: 'Нужен сайт для пекарни',
      sentAt: '2026-10-24T09:00:00.000Z',
    })
    const ours = await fake.addChatMessage({
      chatId: '95300020',
      author: 'specialist',
      text: 'Добрый день, подскажу',
    })
    const odd = await fake.addChatMessage({ chatId: '95300020', author: 'unknown', text: 'кто?' })
    const notice = await fake.addChatMessage({
      chatId: '95300020',
      author: 'system',
      text: 'Вы обменялись контактами',
    })
    expect([client, ours, odd, notice].map((x) => x.platformMessageId)).toEqual([
      'fake-1',
      'fake-2',
      'fake-3',
      'fake-4',
    ])
    expect(notice.eventId).toBeNull()
    const events = checked()
    expect(events.map((e) => [e.id, e.type])).toEqual([
      [client.eventId, 'profi.client_message'],
      [ours.eventId, 'profi.specialist_message'],
      [odd.eventId, 'profi.author_unclear'],
    ])
    expect(events[0]?.payload).toEqual({
      chat_id: '95300020',
      order_id: '95300020',
      platform_message_id: 'fake-1',
      sent_at: '2026-10-24T09:00:00.000Z',
      author: 'client',
    })
    // A message without its order number belongs to the chat's order.
    expect(events[1]?.payload).toMatchObject({ order_id: '95300020', author: 'specialist' })
    for (const e of events) {
      expect(e).toMatchObject({
        entity: { kind: 'chat', id: '95300020' },
        account_id: 'hance-marketing',
        actor: 'profi',
        causation_id: null,
      })
      expect(e.correlation_id).not.toBe(e.id)
      expect(e.occurred_at >= before).toBe(true)
    }
    expect(new Set(events.map((e) => e.correlation_id)).size).toBe(3)
    expect(JSON.stringify(received)).not.toMatch(/пекарни|подскажу|кто\?/)
    expect(received.every((r) => (r as { token: string }).token === 'node-tok')).toBe(true)
    // Messages added in one moment still follow each other in time, as on the page.
    const last = await fake.addChatMessage({ chatId: '95300020', author: 'client', text: 'а' })
    const c = await mcp()
    const msgs = await readChat(c, '95300020')
    expect(msgs.at(-1)?.platform_message_id).toBe(last.platformMessageId)
    const at = msgs.map((m) => Date.parse(String(m.sent_at)))
    expect(at.slice(1).every((t, i) => t > (at[i] ?? 0))).toBe(true)
    await fake.redeliver(client.eventId ?? '')
    expect(bodies().at(-1)).toEqual(bodies()[0])
    await c.close()
  })

  it('FR-CONV-1: read_chat and list_chats answer from the chats the fake keeps', async () => {
    await fake.addChatMessage({
      chatId: '95300021',
      orderId: '95300021',
      author: 'client',
      text: 'Сколько стоит?',
      sentAt: '2026-10-24T09:00:00.000Z',
    })
    await fake.addChatMessage({
      chatId: '95300021',
      author: 'specialist',
      text: 'Зависит от задачи',
      sentAt: '2026-10-24T09:05:00.000Z',
    })
    await fake.addChatMessage({
      chatId: '95300021',
      author: 'client',
      text: 'Лендинг',
      read: true,
      sentAt: '2026-10-24T09:06:00.000Z',
    })
    await fake.addChatMessage({
      chatId: '95300022',
      orderId: null,
      author: 'client',
      text: 'Здравствуйте',
      sentAt: '2026-10-24T10:00:00.000Z',
    })
    const c = await mcp()
    expect(await readChat(c, '95300021')).toEqual([
      {
        platform_message_id: 'fake-1',
        chat_id: '95300021',
        author: 'client',
        sent_at: '2026-10-24T09:00:00.000Z',
        text: 'Сколько стоит?',
        read: false,
      },
      {
        platform_message_id: 'fake-2',
        chat_id: '95300021',
        author: 'specialist',
        sent_at: '2026-10-24T09:05:00.000Z',
        text: 'Зависит от задачи',
        read: false,
      },
      {
        platform_message_id: 'fake-3',
        chat_id: '95300021',
        author: 'client',
        sent_at: '2026-10-24T09:06:00.000Z',
        text: 'Лендинг',
        read: true,
      },
    ])
    const none = await c.callTool({
      name: 'profi.read_chat',
      arguments: { account_id: 'hance-marketing', chat_id: 'unknown' },
    })
    expect(none.isError).toBe(true)
    expect(JSON.stringify(none.content)).toContain('NOT_FOUND')
    const list = await c.callTool({
      name: 'profi.list_chats',
      arguments: { account_id: 'hance-marketing' },
    })
    expect(list.structuredContent).toEqual({
      chats: [
        {
          chat_id: '95300021',
          order_id: '95300021',
          last_message_at: '2026-10-24T09:06:00.000Z',
          unread: 1,
        },
        {
          chat_id: '95300022',
          order_id: null,
          last_message_at: '2026-10-24T10:00:00.000Z',
          unread: 1,
        },
      ],
    })
    await c.close()
  })

  it('FR-CONV-6: the client typing and reading are shipped as events', async () => {
    const before = new Date().toISOString()
    await fake.emitTyping('95300023')
    await fake.emitRead('95300023', 'fake-7')
    const events = checked()
    expect(events.map((e) => e.type)).toEqual(['profi.client_typing', 'profi.client_read'])
    expect(events[0]?.payload).toEqual({ chat_id: '95300023', at: events[0]?.occurred_at })
    expect(events[1]?.payload).toEqual({
      chat_id: '95300023',
      platform_message_id: 'fake-7',
      at: events[1]?.occurred_at,
    })
    for (const e of events) {
      expect(e).toMatchObject({
        entity: { kind: 'chat', id: '95300023' },
        account_id: 'hance-marketing',
        actor: 'profi',
      })
      expect(e.occurred_at >= before).toBe(true)
    }
  })

  it('FR-CONV-9: send_message appends our message only when the chat did not change', async () => {
    const first = await fake.addChatMessage({
      chatId: '95300024',
      orderId: '95300024',
      author: 'client',
      text: 'Нужна реклама',
    })
    const c = await mcp()
    const ok = await c.callTool({
      name: 'profi.send_message',
      arguments: send('95300024', 'Добрый день', 'msg:a', first.platformMessageId),
    })
    expect(ok.structuredContent).toEqual({ found_on_page: true, platform_message_id: 'fake-2' })
    // The client wrote meanwhile: the core's last known message is not the last one any more.
    await fake.addChatMessage({ chatId: '95300024', author: 'client', text: 'И сайт' })
    const stale = await c.callTool({
      name: 'profi.send_message',
      arguments: send('95300024', 'Какой у вас бюджет?', 'msg:b', 'fake-2'),
    })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('CHAT_CHANGED')
    // null means the chat had no messages yet.
    const empty = await c.callTool({
      name: 'profi.send_message',
      arguments: send('95300024', 'Здравствуйте', 'msg:c', null),
    })
    expect(empty.isError).toBe(true)
    expect(JSON.stringify(empty.content)).toContain('CHAT_CHANGED')
    const msgs = await readChat(c, '95300024')
    expect(msgs.map((m) => [m.platform_message_id, m.author, m.read])).toEqual([
      ['fake-1', 'client', false],
      ['fake-2', 'specialist', false],
      ['fake-3', 'client', false],
    ])
    expect(msgs[1]?.text).toBe('Добрый день')
    expect(fake.messages.map((m) => m.idempotency_key)).toEqual(['msg:a'])
    // A first message into a chat the fake does not know yet.
    const fresh = await c.callTool({
      name: 'profi.send_message',
      arguments: send('95300025', 'Добрый день', 'msg:d', null),
    })
    expect(fresh.structuredContent).toEqual({ found_on_page: true, platform_message_id: 'fake-4' })
    const list = await c.callTool({
      name: 'profi.list_chats',
      arguments: { account_id: 'hance-marketing' },
    })
    expect(
      (list.structuredContent as { chats: { chat_id: string; unread: number }[] }).chats,
    ).toMatchObject([
      { chat_id: '95300024', unread: 2 },
      { chat_id: '95300025', unread: 0 },
    ])
    // Our own sends are answers, not news: the fake ships no event for them.
    expect(bodies().map((b) => b.type)).toEqual(['profi.client_message', 'profi.client_message'])
    await c.close()
  })

  it('NFR-REL-4: a send whose answer was lost is not sent again by a repeat with its key', async () => {
    const c = await mcp()
    fake.failNextSendAck()
    const lost = await c
      .callTool({
        name: 'profi.send_message',
        arguments: send('95300026', 'Добрый день', 'msg:e', null),
      })
      .then((r) => ({ answered: !r.isError, text: JSON.stringify(r.content) }))
      .catch((e: unknown) => ({ answered: false, text: String(e) }))
    // Not an answer and not a refusal the core would trust: the message may have gone (UNCERTAIN).
    expect(lost.answered).toBe(false)
    expect(lost.text).not.toContain('errorClass')
    expect(fake.messages).toHaveLength(1)
    // The repeat carries the chat's state from before the send: the key wins over the check.
    const again = await c.callTool({
      name: 'profi.send_message',
      arguments: send('95300026', 'Добрый день', 'msg:e', null),
    })
    expect(again.structuredContent).toEqual({ found_on_page: true, platform_message_id: 'fake-1' })
    expect(fake.messages).toHaveLength(1)
    expect(await readChat(c, '95300026')).toHaveLength(1)
    await c.close()
  })

  it('FR-CONV-2: the fake keeps page order as time order and refuses a time that would break it', async () => {
    await fake.addChatMessage({ chatId: '95300030', author: 'client', text: 'первое' })
    await expect(
      fake.addChatMessage({
        chatId: '95300030',
        author: 'client',
        text: 'раньше',
        sentAt: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/before/)
    await expect(
      fake.addChatMessage({
        chatId: '95300030',
        author: 'client',
        text: 'не время',
        sentAt: 'вчера',
      }),
    ).rejects.toThrow(/time/)
    const c = await mcp()
    const r = await c.callTool({
      name: 'profi.read_chat',
      arguments: { account_id: 'hance-marketing', chat_id: '95300030' },
    })
    expect((r.structuredContent as { messages: unknown[] }).messages).toHaveLength(1)
    await c.close()
  })

  it('FR-CONV-1: a chat without an order number takes the chat number, as the live node does', async () => {
    await fake.addChatMessage({ chatId: '95300031', author: 'client', text: 'привет' })
    const e = received.at(-1) as { body: { payload: { order_id: string | null } } }
    expect(e.body.payload.order_id).toBe('95300031')
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

  it('NFR-MAINT-1: a snapshot carries orders, pages, chats, bids and the wallet over to a new fake', async () => {
    await fake.emitOrder({ order_id: '1', bid_price_rub: 200 })
    await fake.emitOrder({ order_id: '804' })
    fake.setOrderPage('804', { open: false })
    const c = await mcp()
    const first = await c.callTool({ name: 'profi.submit_bid', arguments: bid() })
    await fake.addChatMessage({ chatId: '1', author: 'client', text: 'Здравствуйте!' })
    await c.close()
    const snap = fake.snapshot()
    expect(snap.balance).toBe(4800)

    const again = await createFakeProfi({
      port: 0,
      coreEventsUrl: `http://127.0.0.1:${(core.address() as { port: number }).port}/internal/profi/events`,
      nodeToken: 'node-tok',
      permitSecret: SECRET,
      initial: JSON.parse(JSON.stringify(snap)),
    })
    try {
      const client = new Client({ name: 'test', version: '0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(again.url)))
      const order = (id: string) =>
        client.callTool({
          name: 'profi.get_order',
          arguments: { account_id: 'hance-marketing', order_id: id },
        })
      expect((await order('1')).structuredContent).toMatchObject({ has_bid: true })
      expect((await order('804')).structuredContent).toMatchObject({ open: false })
      // A repeat of the press answers as the first did: nothing is spent twice.
      const repeat = await client.callTool({ name: 'profi.submit_bid', arguments: bid() })
      expect(repeat.structuredContent).toEqual(first.structuredContent)
      expect((await readChat(client, '1')).map((m) => m.text)).toEqual(['Здравствуйте!'])
      const next = await again.addChatMessage({ chatId: '1', author: 'client', text: 'Ау' })
      expect(next.platformMessageId).toBe('fake-2')
      expect(again.snapshot().balance).toBe(4800)
      await client.close()
    } finally {
      await again.close()
    }
  })

  it('NFR-MAINT-1: the hooks hear a new bid and a new message once, and every change', async () => {
    await fake.emitOrder({ order_id: '1' })
    const placed: { order: string; spent: number }[] = []
    const sentTo: string[] = []
    let changes = 0
    fake.onPlaced((i, out) => {
      placed.push({ order: i.order_id, spent: out.spent_rub })
    })
    fake.onSent((i, id) => {
      sentTo.push(`${i.chat_id}:${id}`)
    })
    fake.onChange(() => {
      changes++
    })
    const c = await mcp()
    await c.callTool({ name: 'profi.submit_bid', arguments: bid() })
    await c.callTool({ name: 'profi.submit_bid', arguments: bid() })
    fake.refuseNext('PRICE_CHANGED')
    await c.callTool({ name: 'profi.submit_bid', arguments: bid('bid:2') })
    expect(placed).toEqual([{ order: '1', spent: 210 }])
    const msg = send('1', 'Добрый день', 'msg:h:1', null)
    await c.callTool({ name: 'profi.send_message', arguments: msg })
    await c.callTool({ name: 'profi.send_message', arguments: msg })
    expect(sentTo).toEqual(['1:fake-1'])
    expect(changes).toBeGreaterThanOrEqual(2)
    await c.close()
  })

  it('NFR-MAINT-1: the wallet is set by hand and the health answers it', async () => {
    fake.setBalance(900)
    const c = await mcp()
    const health = await c.callTool({
      name: 'profi.session_health',
      arguments: { account_id: 'hance-marketing' },
    })
    expect(health.structuredContent).toMatchObject({ balance_rub: 900 })
    await fake.emitOrder({ order_id: '1' })
    const out = await c.callTool({ name: 'profi.submit_bid', arguments: bid() })
    expect(out.structuredContent).toMatchObject({ balance_after_rub: 690 })
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
