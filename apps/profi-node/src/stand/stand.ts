import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ClientInfo, type ProfiOrder } from '@sara/shared'
import { z } from 'zod'
import { createFakeProfi, type FakeProfi } from '../fake/fakeProfi'
import { sampleOrders } from '../fake/sampleOrders'
import { type Clients, createClients, type StandPersona, type Timing } from './clients'

export { LIVE_TIMING, type Timing } from './clients'
export type { Behaviour } from './state'

import { STAND_PAGE } from './page'
import { type InlineOrder, listScenarios, readScenario, SCENARIOS_DIR, Scenario } from './scenario'
import {
  BEHAVIOUR_TITLES,
  BEHAVIOURS,
  type Behaviour,
  emptyState,
  loadState,
  moscowDay,
  type ScriptLine,
  type StandState,
  stateWriter,
} from './state'

const BUILT_IN_PERSONAS = join(import.meta.dirname, 'personas.json')
/** The made-up wallet a fresh stand starts with and «Пополнить» fills up to. */
export const START_BALANCE = 5000

/** A real order with nobody's data in it (the core makes it from core.lead): what a copy in the feed shows. */
export const RealCopy = z.object({
  title: z.string(),
  category: z.string(),
  city: z.string(),
  text: z.string(),
  client_name: z.string(),
  budget_text: z.string().nullable(),
  bid_price_rub: z.number().int().nonnegative(),
  client_info: ClientInfo.nullable(),
})
export type RealCopy = z.infer<typeof RealCopy>

/** What the client model gets for one line of the client, and what it answers (the core's trainer-client role). */
export type ClientTurn = {
  persona: Record<string, unknown>
  order: { title: string; text: string; budget_text: string | null }
  /** The hard behaviour the client holds, in words; null: an ordinary client. */
  behaviour: string | null
  dialog: { who: 'клиент' | 'исполнитель'; text: string }[]
}
/** `skipped`: the model was not called at all, so the day's ceiling does not count it. */
export type ClientModel = (
  turn: ClientTurn,
) => Promise<
  | { text: string; ends: 'no' | 'call_agreed' | 'left'; mood: string }
  | { error: string; skipped?: true }
>

export type StandOptions = {
  /** 0: any free port; the stand listens on 127.0.0.1 only. */
  port: number
  host?: string
  coreEventsUrl: string
  nodeToken: string
  permitSecret: string
  /** The stand's own folder: its state survives a restart there. */
  dataDir: string
  model: ClientModel
  /** Copies of real orders with made-up names, read when Boris asks for one. */
  realOrders?: () => Promise<RealCopy[]>
  /** The highest test number the core ever saw (its journal keeps them all): numbering goes on above it. */
  usedUpTo?: () => Promise<number>
  timing: Timing
  limits: { daily: number; perChat: number }
  /** Whether the client model can run now (the token is there), for the page. */
  modelReady?: () => Promise<boolean>
  scenariosDir?: string
  now?: () => Date
  random?: () => number
}

/** An answer of the stand's API: JSON, or the page itself. */
export type StandAnswer = { status: number; json?: unknown; html?: string }

export type Stand = {
  /** The made-up Profi.ru behind contract C2 (MCP); the core's test orders go there, never to the node. */
  mcpUrl: string
  fake: FakeProfi
  clients: Clients
  state: StandState
  /** Puts an order into the made-up feed; the core sees it as a new order of Profi.ru with a test number. */
  addOrder(o: AddOrder): Promise<string>
  runScenario(s: Scenario): Promise<string[]>
  /** The page and its API, for the core to serve under the pult's own login: `path` after the API's prefix. */
  api(method: string, path: string, body: string): Promise<StandAnswer>
  /** Forgets every test order, chat and client; numbers go on counting, so none is ever given twice. */
  reset(): Promise<void>
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
const Persona = z.object({
  id: z.string(),
  archetype: z.string(),
  niche: z.string(),
  task: z.string(),
  mood: z.string(),
  style: z.string(),
  questions: z.array(z.string()),
})

export class StandError extends Error {}

/** Test order numbers: eleven digits from 99, a number Profi.ru never gives (@sara/shared TEST_ORDER). */
export const testOrderId = (n: number) => `99${String(n).padStart(9, '0')}`

/**
 * Made-up Profi.ru for test orders inside the live Sara (docs/ops/test-leads.md): the fake site of the e2e tests behind
 * contract C2, kept on disk, with clients who answer in chats. Never touches the real site (ADR-017).
 */
export async function createStand(o: StandOptions): Promise<Stand> {
  const stateFile = join(o.dataDir, 'state.json')
  const state = await loadState(stateFile)
  // A number is never given twice (the core's durable runs are keyed by it), even if the state file was lost: the
  // count goes on above the saved one, the journal's highest and the clock's seconds.
  const clock = Math.floor((o.now?.() ?? new Date()).getTime() / 1000) % 1_000_000_000
  state.nextOrderNo = Math.max(state.nextOrderNo, clock, ((await o.usedUpTo?.()) ?? 0) + 1)
  let fake: FakeProfi | null = null
  const writer = stateWriter(stateFile, () => ({ ...state, fake: fake?.snapshot() ?? state.fake }))
  const scenarioTimers = new Set<NodeJS.Timeout>()
  const random = o.random ?? Math.random

  const builtIn = z.array(Persona).parse(JSON.parse(await readFile(BUILT_IN_PERSONAS, 'utf8')))
  const personas = async (): Promise<StandPersona[]> => builtIn
  const realCopies = async () => (o.realOrders ? await o.realOrders() : [])

  async function orderFrom(
    from: string | InlineOrder,
  ): Promise<{ order: Omit<ProfiOrder, 'order_id' | 'seen_at'>; source: string; page?: object }> {
    if (typeof from !== 'string') return { order: from, source: 'inline' }
    const [kind, n] = from.split(':')
    if (kind === 'sample') {
      const all = sampleOrders()
      const picked = n ? all.find((x) => x.order_id === n) : all[Math.floor(random() * all.length)]
      if (!picked) throw new StandError(`нет выдуманного заказа ${n}`)
      const { order_id, seen_at: _seen, ...order } = picked
      return { order, source: `sample:${order_id}` }
    }
    const copies = await realCopies()
    if (copies.length === 0) throw new StandError('копий реальных заказов пока нет')
    const i = n ? Number(n) - 1 : Math.floor(random() * copies.length)
    const copy = copies[i]
    if (!copy) throw new StandError(`копий всего ${copies.length}, нет копии ${n}`)
    const { client_info, ...order } = copy
    return { order, source: `real:${i + 1}`, page: client_info ? { client_info } : undefined }
  }

  const f = await createFakeProfi({
    port: o.port,
    host: o.host,
    coreEventsUrl: o.coreEventsUrl,
    nodeToken: o.nodeToken,
    permitSecret: o.permitSecret,
    initial: state.fake ?? undefined,
  })
  fake = f
  if (!state.fake) f.setBalance(START_BALANCE)
  const clients = createClients({
    fake: f,
    state,
    changed: () => writer.later(),
    model: o.model,
    personas,
    limits: o.limits,
    timing: o.timing,
    now: o.now,
    random,
  })
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
      clients.heard(i.order_id, m.platformMessageId)
    } catch (e) {
      console.error('test orders: the bid did not reach the chat', e)
    }
  })
  f.onSent((i, id) => clients.heard(i.chat_id, id))
  clients.resume()
  await writer.now()

  async function addOrder(a: AddOrder): Promise<string> {
    const { order, source, page } = await orderFrom(a.from)
    const id = testOrderId(state.nextOrderNo++)
    state.sources[id] = source
    clients.setPlan(id, {
      behaviour: a.behaviour ?? state.defaultBehaviour,
      personaId: a.persona ?? null,
      script: a.script ?? [],
    })
    if (page) f.setOrderPage(id, page)
    writer.later()
    await f.emitOrder({ ...order, order_id: id, published_at: new Date().toISOString() })
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
        void add().catch((e) => console.error('test orders: scenario', e))
      }, item.after_s * 1000)
      scenarioTimers.add(t)
    }
    return ids
  }

  async function view() {
    const snap = f.snapshot()
    const today = moscowDay((o.now ?? (() => new Date()))())
    return {
      balance: snap.balance,
      defaultBehaviour: state.defaultBehaviour,
      behaviours: BEHAVIOURS.map((id) => ({ id, title: BEHAVIOUR_TITLES[id] })),
      usage: { today: state.usage.day === today ? state.usage.calls : 0, limit: o.limits.daily },
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

  function parse<T>(raw: string, schema: z.ZodType<T>): T {
    try {
      return schema.parse(raw ? JSON.parse(raw) : {})
    } catch {
      throw new StandError('неверный запрос')
    }
  }

  async function api(method: string, path: string, raw: string): Promise<StandAnswer> {
    const post = method === 'POST'
    const chat = /^chats\/(\d+)\/(client|plan|read|typing|close)$/.exec(path)
    try {
      if (method === 'GET' && path === '') return { status: 200, html: STAND_PAGE }
      if (method === 'GET' && path === 'state') return { status: 200, json: await view() }
      if (post && path === 'orders')
        return { status: 200, json: { orderId: await addOrder(parse(raw, OrderBody)) } }
      if (post && path === 'scenario') {
        const b = parse(raw, ScenarioBody)
        const s = 'name' in b ? await readScenario(b.name, o.scenariosDir) : b
        return { status: 200, json: { orderIds: await runScenario(s), title: s.title } }
      }
      if (post && path === 'default') {
        state.defaultBehaviour = parse(raw, DefaultBody).behaviour
        writer.later()
        return { status: 200, json: { ok: true } }
      }
      if (post && path === 'wallet') {
        f.setBalance(parse(raw, WalletBody).balance)
        return { status: 200, json: { ok: true } }
      }
      if (post && chat) {
        const [, id = '', what] = chat
        if (!state.sources[id]) throw new StandError(`нет тестового заказа ${id}`)
        if (what === 'client') await clients.write(id, parse(raw, TextBody).text)
        if (what === 'plan') {
          const b = parse(raw, PlanBody)
          clients.setPlan(id, { behaviour: b.behaviour, personaId: b.persona })
        }
        if (what === 'read') {
          const ours = f
            .snapshot()
            .chats.find((c) => c.chatId === id)
            ?.messages.filter((m) => m.author === 'specialist')
            .at(-1)
          if (ours) await f.emitRead(id, ours.platform_message_id)
        }
        if (what === 'typing') await f.emitTyping(id)
        if (what === 'close') f.setOrderPage(id, { open: false })
        return { status: 200, json: { ok: true } }
      }
      return { status: 404, json: { error: 'нет такой страницы' } }
    } catch (e) {
      const known = e instanceof StandError || (e instanceof Error && e.message.startsWith('нет '))
      if (!known) console.error('test orders', e)
      return {
        status: known ? 400 : 500,
        json: { error: known ? (e as Error).message : `не вышло: ${(e as Error).message}` },
      }
    }
  }

  return {
    mcpUrl: f.url,
    fake: f,
    clients,
    state,
    addOrder,
    runScenario,
    api,
    async reset() {
      for (const t of scenarioTimers) clearTimeout(t)
      scenarioTimers.clear()
      clients.stop()
      const fresh = emptyState()
      // The counter stays: a number given once is never given again (DBOS keys runs by it).
      Object.assign(state, { ...fresh, nextOrderNo: state.nextOrderNo, usage: state.usage })
      f.reset(START_BALANCE)
      await writer.now()
    },
    async close() {
      for (const t of scenarioTimers) clearTimeout(t)
      clients.stop()
      await writer.now()
      await f.close()
    },
  }
}
