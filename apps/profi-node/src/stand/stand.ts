import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ProfiOrder } from '@sara/shared'
import { z } from 'zod'
import { createFakeProfi, type FakeProfi } from '../fake/fakeProfi'
import { sampleOrders } from '../fake/sampleOrders'
import { type Clients, createClients, type StandPersona, type Timing } from './clients'
import type { ClientModel } from './model'
import { STAND_PAGE } from './page'
import { RealCopy } from './pseudonymize'
import { type InlineOrder, listScenarios, readScenario, SCENARIOS_DIR, Scenario } from './scenario'
import {
  BEHAVIOUR_TITLES,
  BEHAVIOURS,
  type Behaviour,
  loadState,
  moscowDay,
  type ScriptLine,
  type StandState,
  stateWriter,
} from './state'

const BUILT_IN_PERSONAS = join(import.meta.dirname, 'personas.json')
/** The wallet a fresh stand starts with and «Пополнить» fills up to. */
export const START_BALANCE = 5000

export type StandOptions = {
  port: number
  host?: string
  coreEventsUrl: string
  nodeToken: string
  permitSecret: string
  /** The stand's own folder: its state, the copies of real orders, the personas from the live trainer. */
  dataDir: string
  model: ClientModel
  timing: Timing
  limits: { daily: number; perChat: number }
  /** Whether the client model can run now (the token is there), for the page. */
  modelReady?: () => Promise<boolean>
  scenariosDir?: string
  now?: () => Date
  random?: () => number
}

export type Stand = {
  url: string
  fake: FakeProfi
  clients: Clients
  state: StandState
  /** Puts an order into the feed of the fake site; the core sees it as a new order on Profi.ru. */
  addOrder(o: AddOrder): Promise<string>
  runScenario(s: Scenario): Promise<string[]>
  close(): Promise<void>
}

export type AddOrder = {
  from: string | InlineOrder
  behaviour?: Behaviour
  persona?: string
  script?: ScriptLine[]
}

const OrderBody = z.object({
  from: z.string().regex(/^(sample|real)(:\d+)?$/),
  behaviour: z.enum(BEHAVIOURS).optional(),
  persona: z.string().optional(),
})
const PlanBody = z.object({
  behaviour: z.enum(BEHAVIOURS).optional(),
  persona: z.string().nullable().optional(),
})
const TextBody = z.object({ text: z.string().trim().min(1).max(2000) })
const DefaultBody = z.object({ behaviour: z.enum(BEHAVIOURS) })
const WalletBody = z.object({ balance: z.number().int().min(0).max(1_000_000) })
const ScenarioBody = z.union([z.object({ name: z.string() }), Scenario])

class StandError extends Error {}

/**
 * The test stand's Profi.ru (docs/ops/staging.md): the fake site of the e2e tests behind contract C2, kept on disk,
 * with clients who answer in chats and a page for Boris at /stand/. Never touches the real site (ADR-017).
 */
export async function createStand(o: StandOptions): Promise<Stand> {
  const stateFile = join(o.dataDir, 'state.json')
  const state = await loadState(stateFile)
  let fake: FakeProfi | null = null
  const writer = stateWriter(stateFile, () => ({ ...state, fake: fake?.snapshot() ?? state.fake }))
  let clients: Clients | null = null
  const scenarioTimers = new Set<NodeJS.Timeout>()

  async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
    try {
      return z.array(schema).parse(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      return []
    }
  }
  const Persona = z.object({
    id: z.string(),
    archetype: z.string(),
    niche: z.string(),
    task: z.string(),
    mood: z.string(),
    style: z.string(),
    questions: z.array(z.string()),
  })
  const personas = async (): Promise<StandPersona[]> => [
    ...(await readJson(BUILT_IN_PERSONAS, Persona)),
    ...(await readJson(join(o.dataDir, 'personas-live.json'), Persona)),
  ]
  const realCopies = () => readJson(join(o.dataDir, 'real-orders.json'), RealCopy)

  async function orderFrom(
    from: string | InlineOrder,
  ): Promise<{ order: Omit<ProfiOrder, 'order_id' | 'seen_at'>; source: string; page?: object }> {
    if (typeof from !== 'string') return { order: from, source: 'inline' }
    const [kind, n] = from.split(':')
    if (kind === 'sample') {
      const all = sampleOrders()
      const picked = n
        ? all.find((x) => x.order_id === n)
        : all[Math.floor((o.random ?? Math.random)() * all.length)]
      if (!picked) throw new StandError(`нет выдуманного заказа ${n}`)
      const { order_id, seen_at: _seen, ...order } = picked
      return { order, source: `sample:${order_id}` }
    }
    const copies = await realCopies()
    if (copies.length === 0)
      throw new StandError('копий реальных заказов нет: запусти pnpm staging import-real')
    const i = n ? Number(n) - 1 : Math.floor((o.random ?? Math.random)() * copies.length)
    const copy = copies[i]
    if (!copy) throw new StandError(`копий всего ${copies.length}, нет копии ${n}`)
    const { client_info, ...order } = copy
    return {
      order,
      source: `real:${i + 1}`,
      page: client_info ? { client_info } : undefined,
    }
  }

  async function addOrder(a: AddOrder): Promise<string> {
    if (!fake || !clients) throw new StandError('стенд ещё запускается')
    const { order, source, page } = await orderFrom(a.from)
    // Ten digits from 99: never the number of an order on the real site, so a link from a card leads nowhere.
    const id = `99${String(state.nextOrderNo++).padStart(8, '0')}`
    state.sources[id] = source
    clients.setPlan(id, {
      behaviour: a.behaviour ?? state.defaultBehaviour,
      personaId: a.persona ?? null,
      script: a.script ?? [],
    })
    if (page) fake.setOrderPage(id, page)
    writer.later()
    await fake.emitOrder({ ...order, order_id: id, published_at: new Date().toISOString() })
    return id
  }

  async function runScenario(s: Scenario): Promise<string[]> {
    const ids: string[] = []
    for (const item of s.orders) {
      const add = () =>
        addOrder({
          from: item.order,
          behaviour: item.client.behaviour,
          persona: item.client.persona,
          script: item.client.script,
        })
      if (item.after_s === 0) {
        ids.push(await add())
        continue
      }
      const t = setTimeout(() => {
        scenarioTimers.delete(t)
        void add().catch((e) => console.error('stand scenario', e))
      }, item.after_s * 1000)
      scenarioTimers.add(t)
    }
    return ids
  }

  async function view() {
    if (!fake || !clients) throw new StandError('стенд ещё запускается')
    const snap = fake.snapshot()
    const today = moscowDay((o.now ?? (() => new Date()))())
    return {
      balance: snap.balance,
      defaultBehaviour: state.defaultBehaviour,
      behaviours: BEHAVIOURS.map((id) => ({ id, title: BEHAVIOUR_TITLES[id] })),
      usage: {
        today: state.usage.day === today ? state.usage.calls : 0,
        limit: o.limits.daily,
      },
      modelReady: o.modelReady ? await o.modelReady() : true,
      realCount: (await realCopies()).length,
      samples: sampleOrders().map((s) => ({ id: s.order_id, title: s.title })),
      scenarios: await listScenarios(o.scenariosDir ?? SCENARIOS_DIR),
      personas: (await personas()).map((p) => ({ id: p.id, archetype: p.archetype })),
      waiting: clients.waiting(),
      orders: snap.orders
        .filter((x) => state.sources[x.order_id])
        .reverse()
        .map((x) => {
          const page = snap.pages.find(([id]) => id === x.order_id)?.[1]
          return {
            id: x.order_id,
            title: x.title,
            category: x.category,
            client_name: x.client_name,
            bid_price_rub: x.bid_price_rub,
            source: state.sources[x.order_id],
            open: page?.open ?? true,
            has_bid: snap.onSite.includes(x.order_id),
            plan: state.plans[x.order_id] ?? null,
            messages: (snap.chats.find((c) => c.chatId === x.order_id)?.messages ?? []).map(
              (m) => ({ author: m.author, text: m.text, at: m.sent_at }),
            ),
          }
        }),
    }
  }

  async function body<T>(raw: string, schema: z.ZodType<T>): Promise<T> {
    try {
      return schema.parse(raw ? JSON.parse(raw) : {})
    } catch {
      throw new StandError('неверный запрос')
    }
  }

  const send = (res: ServerResponse, code: number, data: unknown) =>
    res
      .writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      .end(JSON.stringify(data))

  async function route(req: IncomingMessage, raw: string, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://stand')
    const path = url.pathname
    if (!path.startsWith('/stand')) return false
    if (!fake || !clients) {
      send(res, 503, { error: 'стенд ещё запускается' })
      return true
    }
    const post = req.method === 'POST'
    const chat = /^\/stand\/api\/chats\/(\d+)\/(client|plan|read|typing|close)$/.exec(path)
    try {
      if (req.method === 'GET' && (path === '/stand' || path === '/stand/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(STAND_PAGE)
      } else if (req.method === 'GET' && path === '/stand/api/state') {
        send(res, 200, await view())
      } else if (post && path === '/stand/api/orders') {
        const b = await body(raw, OrderBody)
        send(res, 200, { orderId: await addOrder(b) })
      } else if (post && path === '/stand/api/scenario') {
        const b = await body(raw, ScenarioBody)
        const s = 'name' in b ? await readScenario(b.name, o.scenariosDir) : b
        send(res, 200, { orderIds: await runScenario(s), title: s.title })
      } else if (post && path === '/stand/api/default') {
        state.defaultBehaviour = (await body(raw, DefaultBody)).behaviour
        writer.later()
        send(res, 200, { ok: true })
      } else if (post && path === '/stand/api/wallet') {
        fake.setBalance((await body(raw, WalletBody)).balance)
        send(res, 200, { ok: true })
      } else if (post && chat) {
        const [, id = '', what] = chat
        if (!state.sources[id]) throw new StandError(`нет заказа ${id}`)
        if (what === 'client') await clients.write(id, (await body(raw, TextBody)).text)
        if (what === 'plan') {
          const b = await body(raw, PlanBody)
          clients.setPlan(id, { behaviour: b.behaviour, personaId: b.persona })
        }
        if (what === 'read') {
          const ours = fake
            .snapshot()
            .chats.find((c) => c.chatId === id)
            ?.messages.filter((m) => m.author === 'specialist')
            .at(-1)
          if (ours) await fake.emitRead(id, ours.platform_message_id)
        }
        if (what === 'typing') await fake.emitTyping(id)
        if (what === 'close') fake.setOrderPage(id, { open: false })
        send(res, 200, { ok: true })
      } else {
        send(res, 404, { error: 'нет такой страницы стенда' })
      }
    } catch (e) {
      const known = e instanceof StandError
      if (!known) console.error('stand', e)
      send(res, known ? 400 : 500, {
        error: known ? e.message : `не вышло: ${e instanceof Error ? e.message : e}`,
      })
    }
    return true
  }

  const f = await createFakeProfi({
    port: o.port,
    host: o.host,
    coreEventsUrl: o.coreEventsUrl,
    nodeToken: o.nodeToken,
    permitSecret: o.permitSecret,
    initial: state.fake ?? undefined,
    extra: route,
  })
  fake = f
  if (!state.fake) f.setBalance(START_BALANCE)
  const c = createClients({
    fake: f,
    state,
    changed: () => writer.later(),
    model: o.model,
    personas,
    limits: o.limits,
    timing: o.timing,
    now: o.now,
    random: o.random,
  })
  clients = c
  f.onChange(() => writer.later())
  // As on Profi.ru: the bid is the first message of the order's chat, and the wallet shows what it cost.
  f.onPlaced(async (i, out) => {
    f.setHealth({ balance_rub: out.balance_after_rub })
    try {
      const m = await f.addChatMessage({
        chatId: i.order_id,
        orderId: i.order_id,
        author: 'specialist',
        text: i.text,
      })
      c.heard(i.order_id, m.platformMessageId)
    } catch (e) {
      console.error('stand: the bid did not reach the chat', e)
    }
  })
  f.onSent((i, id) => c.heard(i.chat_id, id))
  c.resume()
  await writer.now()

  return {
    url: f.url.replace(/\/mcp$/, ''),
    fake: f,
    clients: c,
    state,
    addOrder,
    runScenario,
    async close() {
      for (const t of scenarioTimers) clearTimeout(t)
      c.stop()
      await writer.now()
      await f.close()
    },
  }
}
