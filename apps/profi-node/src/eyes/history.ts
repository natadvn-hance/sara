import type { MessageAuthor } from '@sara/shared'
import { and, asc, eq, gte, sql } from 'drizzle-orm'
import type { Page } from 'playwright'
import type { NodeDb } from '../db/client'
import { nodeFlag, rawEvent, rawMessage } from '../db/schema'
import { type StoredMessage, upsertMessage } from '../store/raw'
import type { Insurance } from './insurance'

/**
 * The archive reader (study of past bids, 28.10.2026): once, when the flag `history_read` says «go», the node opens
 * every chat of the account, open and archived, slowly and only to look. The site's own answers carry the messages
 * with their real time; nothing goes to the core as news (no events), the messages are kept as history for
 * `pnpm history:export`. A chat with unread messages or news in the last days is left to the live chat check, so
 * the reader never marks a client's words read and never hands the core a chat to answer. It stops for good at the
 * first page that does not answer or looks like a block (08.10.2026 the site's protection kept v1 out for 48 minutes).
 * Start: `insert into node.node_flag values ('<account>', 'history_read', 'go', now())`; how it goes is the
 * reason of `history_read_status`; set `history_read` to anything else to stop it.
 */

export const HISTORY_FLAG = 'history_read'
export const HISTORY_STATUS = 'history_read_status'

/** A chat of the list answer (`rboMessengersByFilter`): the order it belongs to, its tab, unread count, last time. */
export type ListedChat = {
  orderId: string
  filter: string
  unread: number
  lastAt: string | null
}

type Edge = {
  node?: {
    messengerType?: unknown
    messengerExtId?: unknown
    order?: { rboFilterId?: unknown } | null
    chats?: { unreadMessageCount?: unknown; lastMessage?: { dateCreated?: unknown } | null }[]
  }
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** Every order chat the list answers named, the newest answer winning, and the list's size per tab. */
export function listedChats(bodies: unknown[]): {
  chats: ListedChat[]
  total: Record<string, number>
} {
  const byId = new Map<string, ListedChat>()
  const total: Record<string, number> = {}
  for (const b of bodies) {
    const m = (
      b as { data?: { me?: { rboMessengersByFilter?: { edges?: unknown; totalCount?: unknown } } } }
    )?.data?.me?.rboMessengersByFilter
    if (!m || !Array.isArray(m.edges)) continue
    let filter: string | null = null
    for (const e of m.edges as Edge[]) {
      const n = e?.node
      if (n?.messengerType !== 'ORDER' || n.messengerExtId == null) continue
      const f = typeof n.order?.rboFilterId === 'string' ? n.order.rboFilterId : 'open'
      filter = f
      const chats = Array.isArray(n.chats) ? n.chats : []
      const unread = chats.reduce((s, c) => s + (Number(c?.unreadMessageCount) || 0), 0)
      const lastAt =
        chats
          .map((c) => iso(c?.lastMessage?.dateCreated))
          .filter((x): x is string => x !== null)
          .sort()
          .at(-1) ?? null
      byId.set(String(n.messengerExtId), {
        orderId: String(n.messengerExtId),
        filter: f,
        unread,
        lastAt,
      })
    }
    if (filter !== null && typeof m.totalCount === 'number') total[filter] = m.totalCount
  }
  return { chats: [...byId.values()], total }
}

/**
 * Whose a message is, from who read it (the answer hides its author): Boris's profile read the client's words, the
 * client read ours, both read the site's own notes. Unread messages are ours: a chat with unread client words is
 * never read here. Checked on the 86 messages of 10 live chats against the page's bubbles, 86 of 86 (28.10.2026).
 */
export function authorFromReaders(types: string[]): MessageAuthor {
  const profile = types.includes('PROFILE')
  const client = types.includes('CLIENT')
  if (profile && client) return 'system'
  if (profile) return 'client'
  return 'specialist'
}

type Msg = {
  _id?: unknown
  dateCreated?: unknown
  text?: unknown
  rawText?: unknown
  isDeleted?: unknown
  whoRead?: { extUserType?: unknown }[] | null
}

/** One chat's messages from the site's answers (`messengerChatMessages`), in time order; complete when the first page came. */
export function chatHistory(
  bodies: unknown[],
  orderId: string,
): { messages: StoredMessage[]; complete: boolean } {
  const byId = new Map<string, StoredMessage>()
  let complete = false
  for (const b of bodies) {
    const m = (
      b as { data?: { messengerChatMessages?: { messages?: unknown; hasPrev?: unknown } } }
    )?.data?.messengerChatMessages
    if (!m || !Array.isArray(m.messages)) continue
    if (m.hasPrev === false) complete = true
    for (const x of m.messages as Msg[]) {
      const sentAt = iso(x?.dateCreated)
      if (x?._id == null || sentAt === null || x.isDeleted === true) continue
      const readers = (Array.isArray(x.whoRead) ? x.whoRead : []).map((w) => String(w?.extUserType))
      const text =
        typeof x.text === 'string' ? x.text : typeof x.rawText === 'string' ? x.rawText : ''
      byId.set(String(x._id), {
        platform_message_id: String(x._id),
        chat_id: orderId,
        order_id: orderId,
        author: authorFromReaders(readers),
        sent_at: sentAt,
        text,
        read: true,
      })
    }
  }
  const messages = [...byId.values()].sort(
    (a, b) =>
      a.sent_at.localeCompare(b.sent_at) ||
      a.platform_message_id.localeCompare(b.platform_message_id),
  )
  return { messages, complete }
}

// What a block or a lost login looks like on any page (the words of the site's protection pages and its login form).
const BLOCK =
  /captcha|капч|доступ (?:ограничен|запрещ|временно)|слишком много запросов|too many requests/i

export type HistoryDeps = {
  inTab: Insurance['inTab']
  page: () => Page
  /** The operator's switch: «go» to read, anything else to stop. */
  flag(): Promise<string | null>
  setFlag(name: string, reason: string): Promise<void>
  /** The site's answers of one kind recorded since a moment (null: all that are kept). */
  answers(kind: 'list' | 'chat', since: string | null): Promise<unknown[]>
  /** The node has messages of this chat already: the live check reads it. */
  knownChat(orderId: string): Promise<boolean>
  keep(messages: StoredMessage[]): Promise<number>
  chatsPath: string
  chatPath(orderId: string, filter: string): string
  /** The wait between two pages, at random within it. */
  pauseMs?: [number, number]
  /** Chats with news newer than this are the live check's. */
  quietMs?: number
  sleep?(ms: number): Promise<void>
  now?(): number
  log?(line: string): void
}

const DAY = 24 * 3600_000
const BUSY = 'вкладка занята'
type Tab = Parameters<Parameters<Insurance['inTab']>[0]>[0]

/** One pass over the whole archive; resolves with the line it wrote to the status flag. */
export async function readHistory(d: HistoryDeps): Promise<string> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = d.now ?? Date.now
  const [lo, hi] = d.pauseMs ?? [45_000, 90_000]
  const pause = () => sleep(lo + Math.random() * (hi - lo))
  const log = d.log ?? ((l: string) => console.log(`История чатов: ${l}`))
  const at = () => new Date(now()).toISOString()
  const status = async (line: string) => {
    log(line)
    await d.setFlag(HISTORY_STATUS, line).catch(() => {})
  }
  const stop = async (why: string) => {
    const line = `остановлено: ${why}`
    await status(line)
    await d.setFlag(HISTORY_FLAG, 'stopped').catch(() => {})
    return line
  }
  const looksBlocked = async () => {
    const p = d.page()
    if (/\/login|auth/i.test(p.url())) return true
    const text = await p
      .locator('body')
      .innerText({ timeout: 5000 })
      .catch(() => '')
    return BLOCK.test(text.slice(0, 5000))
  }

  // The tab is not free while Boris watches the live screen or the IP is wrong: the reader waits, an hour at most.
  async function whenFree<T>(f: (t: Tab) => Promise<T | typeof BUSY>): Promise<T | typeof BUSY> {
    let r: T | typeof BUSY = BUSY
    for (let tries = 0; r === BUSY && tries < 12; tries++) {
      if (tries > 0) await sleep(5 * 60_000)
      r = await d.inTab((t) => (t.can() ? f(t) : Promise.resolve(BUSY)))
    }
    return r
  }

  // 1. The lists: both tabs, scrolled down until they hold all their chats or stop growing.
  for (const filter of ['open', 'archive']) {
    if ((await d.flag()) !== 'go') return stop('флаг снят')
    const since = at()
    const r = await whenFree(async (t) => {
      if (!(await t.go(filter === 'open' ? d.chatsPath : `${d.chatsPath}?filter=archive`)))
        return 'список чатов не открылся'
      if (await looksBlocked()) return 'страница похожа на блокировку'
      await sleep(3000)
      for (let i = 0, still = 0; i < 20 && still < 3; i++) {
        const seen = listedChats(await d.answers('list', since))
        const n = seen.chats.filter((c) => c.filter === filter).length
        if (n >= (seen.total[filter] ?? Number.POSITIVE_INFINITY)) break
        await d
          .page()
          .evaluate(scrollListDown)
          .catch(() => {})
        await sleep(2500)
        const after = listedChats(await d.answers('list', since)).chats.filter(
          (c) => c.filter === filter,
        ).length
        still = after > n ? 0 : still + 1
      }
      return 'ok'
    })
    if (r !== 'ok') return stop(r)
    await pause()
  }

  // 2. Each chat once, oldest first, with a pause between pages.
  const { chats, total } = listedChats(await d.answers('list', null))
  const todo: ListedChat[] = []
  let skipped = 0
  for (const c of chats.sort((a, b) => (a.lastAt ?? '').localeCompare(b.lastAt ?? ''))) {
    const fresh = c.lastAt !== null && now() - Date.parse(c.lastAt) < (d.quietMs ?? 4 * DAY)
    if (c.unread > 0 || fresh || (await d.knownChat(c.orderId))) skipped++
    else todo.push(c)
  }
  await status(
    `в списках ${chats.length} чатов (открытых ${total.open ?? '?'}, в архиве ${total.archive ?? '?'}), читаю ${todo.length}, оставляю живой проверке ${skipped}`,
  )
  let done = 0
  let kept = 0
  let partial = 0
  let empty = 0
  for (const c of todo) {
    await pause()
    if ((await d.flag()) !== 'go') return stop(`флаг снят, прочитано ${done} из ${todo.length}`)
    const since = at()
    const got = await whenFree<{ messages: StoredMessage[]; complete: boolean } | string>(
      async (t) => {
        if (!(await t.go(d.chatPath(c.orderId, c.filter)))) return 'страница чата не открылась'
        if (await looksBlocked()) return 'страница похожа на блокировку'
        await sleep(3000)
        let h = chatHistory(await d.answers('chat', since), c.orderId)
        // Older messages come as the list is scrolled up; a chat that does not grow twice is as long as it gets.
        for (
          let i = 0, still = 0;
          i < 8 && !h.complete && h.messages.length > 0 && still < 2;
          i++
        ) {
          await d
            .page()
            .evaluate(scrollChatUp)
            .catch(() => {})
          await sleep(2500)
          const next = chatHistory(await d.answers('chat', since), c.orderId)
          still = next.messages.length > h.messages.length ? 0 : still + 1
          h = next
        }
        return h
      },
    )
    if (typeof got === 'string') return stop(`${got}, прочитано ${done} из ${todo.length}`)
    if (got.messages.length === 0) {
      // Two chats in a row without an answer: the page is not what it was, a developer looks first.
      if (++empty >= 2)
        return stop(`два чата подряд без сообщений, прочитано ${done} из ${todo.length}`)
      continue
    }
    empty = 0
    if (!got.complete) partial++
    kept += await d.keep(got.messages)
    done++
    if (done % 10 === 0) await status(`прочитано ${done} из ${todo.length}, сообщений ${kept}`)
  }
  const line = `готово: прочитано ${done} чатов из ${todo.length}, сообщений ${kept}, неполных ${partial}`
  await status(line)
  await d.setFlag(HISTORY_FLAG, 'done').catch(() => {})
  return line
}

// Runs in the page: the chat list scrolls inside its own pane on the left, the page itself as the fallback.
function scrollListDown() {
  const panes = [...document.querySelectorAll('*')].filter((e) => {
    const s = getComputedStyle(e)
    const r = e.getBoundingClientRect()
    return (
      e.scrollHeight > e.clientHeight + 50 &&
      /auto|scroll/.test(s.overflowY) &&
      r.left < 400 &&
      r.width < 700
    )
  })
  for (const p of panes) p.scrollTop = p.scrollHeight
  window.scrollTo(0, document.body.scrollHeight)
}

// Runs in the page: the pane that holds the message bubbles, scrolled to its top.
function scrollChatUp() {
  let el = document.querySelector('[data-message-content-id]')?.parentElement ?? null
  while (
    el &&
    !(el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY))
  )
    el = el.parentElement
  if (el) el.scrollTop = 0
}

/** Checks the flag every few minutes and reads the archive once when it says «go». */
export function startHistoryRead(d: HistoryDeps, everyMs = 5 * 60_000): { stop(): void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void (async () => {
      if ((await d.flag()) === 'go') await readHistory(d)
    })()
      .catch((e) => console.error('История чатов:', e instanceof Error ? e.message : e))
      .finally(() => {
        running = false
      })
  }, everyMs)
  return { stop: () => clearInterval(timer) }
}

// Only what the reader needs of a list answer: a whole one weighs tens of kilobytes and thousands are kept.
const LIST_PART = sql`jsonb_build_object('data', jsonb_build_object('me', jsonb_build_object('rboMessengersByFilter',
  jsonb_build_object('totalCount', m->'totalCount', 'edges', coalesce((select jsonb_agg(jsonb_build_object('node',
    jsonb_build_object('messengerType', e->'node'->'messengerType', 'messengerExtId', e->'node'->'messengerExtId',
      'order', jsonb_build_object('rboFilterId', e->'node'->'order'->'rboFilterId'),
      'chats', coalesce((select jsonb_agg(jsonb_build_object('unreadMessageCount', c->'unreadMessageCount',
        'lastMessage', jsonb_build_object('dateCreated', c->'lastMessage'->'dateCreated')))
        from jsonb_array_elements(e->'node'->'chats') c), '[]'::jsonb))))
    from jsonb_array_elements(m->'edges') e), '[]'::jsonb)))))`

/** The reader's flags, the site's answers and the messages it keeps, in the node's own tables. */
export function historyStore(
  db: NodeDb,
  accountId: string,
): Pick<HistoryDeps, 'flag' | 'setFlag' | 'answers' | 'knownChat' | 'keep'> {
  return {
    async flag() {
      const [r] = await db
        .select({ reason: nodeFlag.reason })
        .from(nodeFlag)
        .where(and(eq(nodeFlag.accountId, accountId), eq(nodeFlag.name, HISTORY_FLAG)))
      return r?.reason ?? null
    },
    async setFlag(name, reason) {
      const setAt = new Date().toISOString()
      await db
        .insert(nodeFlag)
        .values({ accountId, name, reason, setAt })
        .onConflictDoUpdate({ target: [nodeFlag.accountId, nodeFlag.name], set: { reason, setAt } })
    },
    async answers(kind, since) {
      const mine = and(
        eq(rawEvent.accountId, accountId),
        eq(rawEvent.kind, 'response'),
        since ? gte(rawEvent.receivedAt, since) : undefined,
      )
      if (kind === 'chat') {
        const rows = await db
          .select({ body: rawEvent.body })
          .from(rawEvent)
          .where(and(mine, sql`${rawEvent.body}->'data'->'messengerChatMessages' is not null`))
          .orderBy(asc(rawEvent.receivedAt))
        return rows.map((r) => r.body)
      }
      const rows = await db
        .select({ body: sql<unknown>`${LIST_PART}` })
        .from(sql`(select ${rawEvent.body}->'data'->'me'->'rboMessengersByFilter' as m, ${rawEvent.receivedAt} as at
          from ${rawEvent} where ${mine}) as l`)
        .where(sql`m is not null`)
        .orderBy(sql`at`)
      return rows.map((r) => r.body)
    },
    async knownChat(orderId) {
      const rows = await db
        .select({ id: rawMessage.platformMessageId })
        .from(rawMessage)
        .where(and(eq(rawMessage.accountId, accountId), eq(rawMessage.chatId, orderId)))
        .limit(1)
      return rows.length > 0
    },
    async keep(messages) {
      let n = 0
      for (const message of messages)
        if (await upsertMessage(db, { accountId, message, history: true })) n++
      return n
    },
  }
}
