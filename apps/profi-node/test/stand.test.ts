import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type EventEnvelope, isTestOrder } from '@sara/shared'
import { signMessagePermit, signPermit } from '@sara/shared/permit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEAVE_TEXT, type Timing } from '../src/stand/clients'
import {
  type ClientModel,
  type ClientTurn,
  createStand,
  type RealCopy,
  type Stand,
} from '../src/stand/stand'

// Made-up Profi.ru for test orders inside the live Sara (docs/ops/test-leads.md). Invented orders and clients only.
const SECRET = 'stand-permit'
const FAST: Timing = { readMs: [10, 20], firstReplyMs: [60, 80], replyMs: [40, 60], typingMs: 10 }

let core: ReturnType<typeof createServer>
let events: EventEnvelope[]
let coreUrl: string
let dir: string
let stand: Stand
let turns: ClientTurn[]
let answers: Awaited<ReturnType<ClientModel>>[]
let copies: RealCopy[]

async function until(cond: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('condition not met in time')
}

async function open(o: { daily?: number; perChat?: number } = {}) {
  stand = await createStand({
    port: 0,
    realOrders: async () => copies,
    coreEventsUrl: coreUrl,
    nodeToken: 'node-tok',
    permitSecret: SECRET,
    dataDir: dir,
    model: async (t) => {
      turns.push(t)
      return answers.shift() ?? { text: 'Хорошо, спасибо', ends: 'no', mood: 'neutral' }
    },
    timing: FAST,
    limits: { daily: o.daily ?? 40, perChat: o.perChat ?? 8 },
  })
  return stand
}

beforeEach(async () => {
  events = []
  turns = []
  answers = []
  copies = []
  core = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      events.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"accepted":true}')
    })
  })
  await new Promise<void>((r) => core.listen(0, '127.0.0.1', r))
  coreUrl = `http://127.0.0.1:${(core.address() as { port: number }).port}/internal/profi/events`
  dir = await mkdtemp(join(tmpdir(), 'stand-'))
})
afterEach(async () => {
  await stand?.close()
  core.close()
})

async function mcp() {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(stand.mcpUrl)))
  return client
}

/** Sara's bid as the core sends it: signed by the stand core's permit. */
async function bid(orderId: string, text = 'Добрый день! Прочитал заказ, давайте обсудим.') {
  const unsigned = {
    account_id: 'hance-marketing',
    order_id: orderId,
    text,
    max_fee_rub: 1000,
    not_after: new Date(Date.now() + 60_000).toISOString(),
    idempotency_key: `bid:${orderId}`,
  }
  const c = await mcp()
  const out = await c.callTool({
    name: 'profi.submit_bid',
    arguments: { ...unsigned, permit: signPermit(SECRET, unsigned) },
  })
  await c.close()
  return out.structuredContent as { balance_after_rub: number; spent_rub: number }
}

async function message(chatId: string, text: string, expect: string | null) {
  const key = `msg:${chatId}:${text.length}`
  const c = await mcp()
  await c.callTool({
    name: 'profi.send_message',
    arguments: {
      account_id: 'hance-marketing',
      chat_id: chatId,
      text,
      expect_last_message_id: expect,
      idempotency_key: key,
      permit: signMessagePermit(SECRET, { accountId: 'hance-marketing', chatId, text, key }),
    },
  })
  await c.close()
}

// The people's messages: the site's own line after the first client word (01.11.2026, c9ee91b7) is left out.
const chat = (id: string) =>
  (stand.fake.snapshot().chats.find((c) => c.chatId === id)?.messages ?? []).filter(
    (m) => m.author !== 'system',
  )
// The id our next message is sent against: the chat's very last message, the site's line included.
const lastId = (id: string) =>
  stand.fake
    .snapshot()
    .chats.find((c) => c.chatId === id)
    ?.messages.at(-1)?.platform_message_id ?? null
const types = (id: string) =>
  events.filter((e) => e.entity.id === id && e.type !== 'profi.order_seen').map((e) => e.type)

async function api(path: string, body?: unknown) {
  const a = await stand.api(
    body === undefined ? 'GET' : 'POST',
    path,
    body === undefined ? '' : JSON.stringify(body),
  )
  return { status: a.status, body: (a.json ?? {}) as Record<string, unknown> }
}

describe('the test stand', () => {
  it('FR-LEAD-9: an order goes into the feed under a test number no real order has, the bid lands in its chat for free', async () => {
    await open()
    const id = await stand.addOrder({ from: 'sample:90000015', behaviour: 'manual' })
    expect(isTestOrder(id)).toBe(true)
    const seen = events.find((e) => e.type === 'profi.order_seen')
    expect(seen?.entity.id).toBe(id)
    expect(seen?.payload).toMatchObject({
      order_id: id,
      title: 'Диагностика маркетинга и позиционирование сети студий',
    })
    const out = await bid(id)
    expect(out).toMatchObject({ spent_rub: 210, balance_after_rub: 4790 })
    await until(() => chat(id).length === 1)
    expect(chat(id)[0]).toMatchObject({
      author: 'specialist',
      text: 'Добрый день! Прочитал заказ, давайте обсудим.',
    })
    const c = await mcp()
    const health = await c.callTool({
      name: 'profi.session_health',
      arguments: { account_id: 'hance-marketing' },
    })
    expect(health.structuredContent).toMatchObject({ balance_rub: 4790 })
    await c.close()
  })

  it('NFR-MAINT-1: a scripted client reads the bid, types and says its lines one after our messages', async () => {
    await open()
    const id = await stand.addOrder({
      from: 'sample',
      behaviour: 'script',
      script: [{ text: 'Сколько стоит?' }, { wait_s: 0, text: 'А сроки?' }],
    })
    await bid(id)
    await until(() => chat(id).some((m) => m.author === 'client'))
    expect(chat(id).map((m) => m.text)).toEqual([
      'Добрый день! Прочитал заказ, давайте обсудим.',
      'Сколько стоит?',
    ])
    expect(types(id)).toEqual(
      expect.arrayContaining(['profi.client_read', 'profi.client_typing', 'profi.client_message']),
    )
    await message(id, 'От 40 до 60 тысяч.', lastId(id))
    await until(() => stand.state.plans[id]?.ended === true)
    expect(chat(id).at(-1)?.text).toBe('А сроки?')
    expect(stand.state.plans[id]).toMatchObject({ replies: 2, ended: true })
    expect(turns).toEqual([])
  })

  it('NFR-MAINT-1: a client who leaves says so once and the order closes', async () => {
    await open()
    const id = await stand.addOrder({ from: 'sample', behaviour: 'leaves' })
    await bid(id)
    await until(() => chat(id).at(-1)?.text === LEAVE_TEXT)
    const c = await mcp()
    const page = await c.callTool({
      name: 'profi.get_order',
      arguments: { account_id: 'hance-marketing', order_id: id },
    })
    expect(page.structuredContent).toMatchObject({ open: false, has_bid: true })
    await c.close()
    await message(id, 'Жаль, удачи!', lastId(id))
    await new Promise((r) => setTimeout(r, 200))
    expect(chat(id).filter((m) => m.author === 'client')).toHaveLength(1)
  })

  it('NFR-MAINT-1: a silent client reads the bid and never writes', async () => {
    await open()
    const id = await stand.addOrder({ from: 'sample', behaviour: 'silent' })
    await bid(id)
    await until(() => types(id).includes('profi.client_read'))
    await new Promise((r) => setTimeout(r, 200))
    expect(chat(id).filter((m) => m.author === 'client')).toEqual([])
  })

  it('NFR-COST-1: the model plays the client by persona and order, once our messages settle, within its ceilings', async () => {
    await open({ daily: 2 })
    const id = await stand.addOrder({
      from: 'sample:90000004',
      behaviour: 'price',
      persona: 'p-stand-factory',
    })
    answers.push({ text: 'Сколько это будет стоить?', ends: 'no', mood: 'bargaining' })
    await bid(id)
    await until(() => chat(id).at(-1)?.text === 'Сколько это будет стоить?')
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      persona: { id: 'p-stand-factory', name: 'Алексей' },
      order: { title: 'Стратегия запуска нового бренда одежды' },
      dialog: [{ who: 'исполнитель', text: 'Добрый день! Прочитал заказ, давайте обсудим.' }],
    })
    expect(turns[0]?.behaviour).toContain('цену')
    answers.push({ text: 'Дорого, мы выбрали другого', ends: 'left', mood: 'irritation' })
    await message(id, 'От 80 тысяч.', lastId(id))
    await until(() => stand.state.plans[id]?.ended === true)
    // The day's ceiling of two calls is spent: the next client waits for Boris.
    const other = await stand.addOrder({ from: 'sample', behaviour: 'answers' })
    await bid(other)
    await until(() => (stand.state.plans[other]?.note ?? '').includes('потолок'))
    expect(turns).toHaveLength(2)
    expect(chat(other).filter((m) => m.author === 'client')).toEqual([])
  })

  it('NFR-COST-1: a call the model never made, for want of the token, does not count against the day', async () => {
    await open()
    answers.push({ error: 'нет токена Claude: пройди мастер в пульте стенда', skipped: true })
    const id = await stand.addOrder({ from: 'sample', behaviour: 'answers' })
    await bid(id)
    await until(() => (stand.state.plans[id]?.note ?? '').includes('токена'))
    expect(stand.state.usage.calls).toBe(0)
  })

  it('NFR-MAINT-1: Boris writes as the client from the page, and changes how a client behaves', async () => {
    await open()
    const { body } = await api('orders', { from: 'sample', behaviour: 'manual' })
    const id = String(body.orderId)
    await bid(id)
    await until(() => chat(id).length === 1)
    expect(
      (await api(`chats/${id}/client`, { text: 'Здравствуйте! Когда сможете начать?' })).status,
    ).toBe(200)
    expect(chat(id).at(-1)).toMatchObject({
      author: 'client',
      text: 'Здравствуйте! Когда сможете начать?',
    })
    expect(types(id)).toContain('profi.client_read')
    expect((await api(`chats/${id}/plan`, { behaviour: 'silent' })).status).toBe(200)
    expect(stand.state.plans[id]?.behaviour).toBe('silent')
    expect((await api(`chats/${id}/close`, {})).status).toBe(200)
    const state = await api('state')
    const shown = (state.body.orders as { id: string; open: boolean; messages: unknown[] }[]).find(
      (o) => o.id === id,
    )
    expect(shown).toMatchObject({ open: false })
    // The bid, the client's word and the site's line after it, as Profi.ru shows them.
    expect(shown?.messages).toHaveLength(3)
    expect((await api('chats/1/client', { text: 'Ау' })).status).toBe(400)
    expect((await stand.api('GET', '', '')).html).toContain('Тестовые заявки')
  })

  it('NFR-MAINT-1: the stand starts where it stopped, and a client still owed an answer gets it', async () => {
    await open()
    const id = await stand.addOrder({
      from: 'sample',
      behaviour: 'script',
      script: [{ wait_s: 1, text: 'Здравствуйте!' }],
    })
    await bid(id)
    await until(() => chat(id).length === 1)
    await stand.close()
    await open()
    expect(stand.state.sources[id]).toMatch(/^sample:/)
    await until(() => chat(id).at(-1)?.text === 'Здравствуйте!', 4000)
    const next = await stand.addOrder({ from: 'sample', behaviour: 'manual' })
    expect(Number(next)).toBe(Number(id) + 1)
    // Erased and started over, the numbers still go on: none is ever given twice.
    await stand.reset()
    expect(stand.state.sources).toEqual({})
    expect(stand.fake.snapshot()).toMatchObject({ chats: [], orders: [], balance: 5000 })
    expect(Number(await stand.addOrder({ from: 'sample', behaviour: 'manual' }))).toBe(
      Number(id) + 2,
    )
  })

  it('NFR-MAINT-1: a scenario from the repository puts its orders with their clients', async () => {
    await open()
    const { body } = await api('scenario', { name: 'answers' })
    const [id] = body.orderIds as string[]
    expect(body.title).toBe('Клиент отвечает')
    expect(stand.state.plans[id ?? '']).toMatchObject({
      behaviour: 'answers',
      personaId: 'p-stand-salon',
    })
    const state = await api('state')
    expect((state.body.scenarios as { name: string }[]).map((s) => s.name)).toContain('full-day')
    expect((await api('scenario', { name: '../x' })).status).toBe(400)
  })

  it('NFR-PRIV-2: a copy of a real order comes with its made-up client on the page', async () => {
    const copy: RealCopy = {
      title: 'Продвижение школы танцев',
      category: 'Маркетинговая стратегия',
      city: 'Краснодар',
      text: 'Меня зовут Вера, нужна стратегия.',
      client_name: 'Вера',
      budget_text: null,
      bid_price_rub: 330,
      client_info: {
        name: 'Вера',
        on_profi_since: null,
        phone_verified: true,
        reviews: null,
        review_tags: [],
      },
    }
    copies = [copy]
    await open()
    const id = await stand.addOrder({ from: 'real:1', behaviour: 'manual' })
    expect(stand.state.sources[id]).toBe('real:1')
    const c = await mcp()
    const page = await c.callTool({
      name: 'profi.get_order',
      arguments: { account_id: 'hance-marketing', order_id: id },
    })
    expect(page.structuredContent).toMatchObject({
      client_name: 'Вера',
      bid_price_rub: 330,
      client_info: { name: 'Вера' },
    })
    await c.close()
    expect((await api('orders', { from: 'real:5' })).body.error).toContain('всего 1')
  })
})
