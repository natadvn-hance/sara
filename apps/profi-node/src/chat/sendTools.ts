import {
  type MessageAuthor,
  normalizeText,
  type SendMessageInput,
  type SendMessageOutput,
} from '@sara/shared'
import { verifyMessagePermit } from '@sara/shared/permit'
import type { Locator, Page, Response } from 'playwright'
import type { NodeDb } from '../db/client'
import { anonymousChatUrl, CHAT_INPUT, CHAT_SEND_PATH, readChatFormMap } from '../eyes/chatFormMap'
import type { Eyes } from '../eyes/eyes'
import type { Insurance } from '../eyes/insurance'
import { BUBBLE } from '../eyes/pageShape'
import type { MessageSignal, ParseResult, Parsers } from '../eyes/parsers'
import { ProfiToolError, type ProfiToolsImpl } from '../mcp/server'
import { findMessageAttempt, saveMessagePress, saveMessageResult } from '../store/raw'
import { detectSessionState, requireAlive, type SessionState } from '../watch/sessionWatch'

export type SendRuntime = {
  watch: { state(): SessionState }
  /** onChatRead: what the page showed goes to the eyes too, so a news message is known at once (not at the next sweep). */
  eyes: Pick<Eyes, 'onChatRead' | 'onRaw'>
  /** The account tab, in turn with the feed check; can() is false while the tab may not move or is not there. */
  inTab: Insurance['inTab']
  page(): Page
}

export type Typing = {
  /** Milliseconds between two keys, a little random between these two. */
  charMs: [number, number]
  /** A long text is typed faster, so that typing it never takes longer than this. */
  budgetMs: number
  /** A look at the chat before typing and a pause before the send button, a little random between these two. */
  lookMs: [number, number]
}

type Tab = { go(path: string): Promise<boolean>; can(): boolean }
type Seen = { id: string; author: MessageAuthor; text: string }
type Read = { parsed: ParseResult; messages: Seen[] }

const fail = (c: ConstructorParameters<typeof ProfiToolError>[0], m: string) =>
  new ProfiToolError(c, m)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const between = ([a, b]: [number, number]) => a + Math.random() * Math.max(0, b - a)

// Old Sara's last check before a client's chat (src/analyzer/clientText.js assertSendable, 30.09.2026: a reminder
// reached a client as {"message": ...}): text shaped like protocol is never typed, whatever produced it.
function leaksProtocol(text: string): boolean {
  if (/<\/?parameter\b/i.test(text)) return true
  const t = text.trim()
  if (!/^[{[]/.test(t)) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return /^\{\s*"/.test(t)
  }
}

/** A line in pieces of `size` characters for typing, cut by whole characters: an emoji is never split in two keys. */
export function typingChunks(line: string, size = 10): string[] {
  const letters = Array.from(line)
  const out: string[] = []
  for (let at = 0; at < letters.length; at += size) out.push(letters.slice(at, at + size).join(''))
  return out
}

/**
 * profi.send_message on the site itself (FR-CONV-9, NFR-REL-4, M4). The chat is opened the way old Sara opened it
 * (r.php?id=<chat>), read twice until it holds still, and compared with what the core saw (CHAT_CHANGED). Then the
 * text is typed into her field, textarea[placeholder="Сообщение"], at a person's pace and checked back, and sent with
 * her button: the last button of the field's third ancestor div. A message counts only when a new bubble of our side
 * with this text stands in the chat afterwards. A press is written down before it happens: after it, a call with the
 * same key (also after a restart) only looks. Off unless the environment says so (SARA_NODE_SEND_MESSAGES=1).
 */
export function createSendTools(o: {
  db: NodeDb
  permitSecret: string
  parsers: Parsers
  accounts: Map<string, SendRuntime>
  /** The node's switch: when false the tool answers INTERNAL and touches nothing. */
  enabled: boolean
  /** How long a call waits for the account tab (the feed check and the chat walk go first), then UNCERTAIN. */
  queueMs?: number
  /** How long after the press the new message is looked for. */
  confirmMs?: number
  /**
   * The last moment to press, counted from the arrival of the call: the core waits 4 minutes, and its answer must
   * still come after the press and its look (the message permit carries no deadline of its own).
   */
  pressBudgetMs?: number
  /** How long a freshly opened chat may take to show its first bubble or its field. */
  boxMs?: number
  /** How long a chat the core thinks empty is given to draw its bubbles before it counts as empty. */
  emptyMs?: number
  /** The pause between the two readings that must agree, and between two looks after the press. */
  stableMs?: number
  /** After the new bubble is first seen: how long it must still be there, under the same number, to count. */
  settleMs?: number
  pollMs?: number
  typing?: Partial<Typing>
}): Pick<ProfiToolsImpl, 'sendMessage'> {
  const queueMs = o.queueMs ?? 150_000
  const confirmMs = o.confirmMs ?? 15_000
  // 4 minutes of the core's wait, less the look after the press and half a minute.
  const pressBudgetMs = o.pressBudgetMs ?? 240_000 - confirmMs - 30_000
  const boxMs = o.boxMs ?? 15_000
  const emptyMs = o.emptyMs ?? 5000
  const stableMs = o.stableMs ?? 1000
  const settleMs = o.settleMs ?? 1500
  const pollMs = o.pollMs ?? 500
  const typing: Typing = {
    charMs: [30, 80],
    budgetMs: 25_000,
    lookMs: [500, 1500],
    ...o.typing,
  }
  const uncertain = (why: string) => fail('UNCERTAIN', why)
  const stillUnknown = () =>
    uncertain('Сообщение нажато, но страница его не показала: смотреть чат, а не слать снова')
  // The box is mapped once more while a message is typed: the send button changes with the text in the field.
  let typedMapKept = false

  const runtime = (id: string) => {
    const r = o.accounts.get(id)
    if (!r) throw fail('NOT_FOUND', `account ${id} is not served here`)
    return r
  }

  const messagesOf = (p: ParseResult): Seen[] =>
    p.signals
      .filter((s): s is MessageSignal => s.t === 'message')
      .map((s) => ({
        id: s.message.platform_message_id,
        author: s.message.author,
        text: s.message.text,
      }))

  /** The tab stands on this chat's own address (the site may land it on another chat, or on a list). */
  const onChat = (page: Page, chatId: string): boolean => {
    try {
      const want = new URL(o.parsers.paths.chat(chatId), 'http://x.invalid')
      const got = new URL(page.url())
      if (got.pathname !== want.pathname) return false
      for (const [k, v] of want.searchParams) if (got.searchParams.get(k) !== v) return false
      return true
    } catch {
      return false
    }
  }

  /**
   * Opens the chat like old Sara: its own address, then a bubble or the field, whichever comes first. The page must
   * be that chat's: nothing of another chat is read, typed into or given to the eyes.
   */
  async function openChat(r: SendRuntime, t: Tab, chatId: string): Promise<Page> {
    if (!(await t.go(o.parsers.paths.chat(chatId))))
      throw fail('RATE_LIMITED', 'Страница чата не открылась, сообщение не набрано')
    const page = r.page()
    const loaded = await page.waitForSelector(`${BUBBLE}, ${CHAT_INPUT}`, { timeout: boxMs }).then(
      () => true,
      () => false,
    )
    if (loaded && onChat(page, chatId)) return page
    const state = await detectSessionState(page, o.parsers.banMarkers)
    if (state === 'dead') throw fail('SESSION_DEAD', 'Профи.ру разлогинил аккаунт')
    if (state === 'banned') throw fail('BANNED', 'Профи.ру заблокировал профиль')
    throw fail(
      'NOT_FOUND',
      loaded
        ? `Адрес чата ${chatId} привёл на другую страницу, сообщение не набрано`
        : `Чат ${chatId} не открылся: на странице нет ни сообщений, ни поля ввода`,
    )
  }

  /**
   * The chat as the page shows it, read twice with a pause: a feed that is still being drawn gives two different
   * readings (old Sara, ChatUnstableError). What the page showed also goes to the eyes, as a chat sweep would.
   */
  async function readStable(
    r: SendRuntime,
    page: Page,
    chatId: string,
    empty: boolean,
  ): Promise<Read> {
    // A chat the core thinks empty may still be drawing: the field comes before the bubbles. It is waited for longer,
    // as its emptiness decides whether anything is typed.
    const waitMs = empty ? emptyMs : boxMs
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = messagesOf(await o.parsers.fromChatDom(page, chatId, { waitMs }))
      await sleep(stableMs)
      const parsed = await o.parsers.fromChatDom(page, chatId, { waitMs: 1000 })
      const second = messagesOf(parsed)
      if (first.length === second.length && first.at(-1)?.id === second.at(-1)?.id) {
        await r.eyes.onChatRead(chatId, parsed).catch(() => {})
        return { parsed, messages: second }
      }
    }
    throw fail('RATE_LIMITED', 'Лента чата не успокоилась, сообщение не набрано')
  }

  /** A new bubble of our side with this text, after the message the core last saw. */
  const findSent = (messages: Seen[], text: string, after: string | null): Seen | null => {
    const from = after === null ? 0 : messages.findIndex((m) => m.id === after) + 1
    // The message the core saw is no longer on the page: there is nothing to measure a new one against.
    if (after !== null && from === 0) return null
    return (
      messages
        .slice(from)
        .find((m) => m.author === 'specialist' && normalizeText(m.text) === normalizeText(text)) ??
      null
    )
  }

  async function clearDraft(field: Locator) {
    await field.fill('', { timeout: 3000 }).catch(() => {})
  }

  /** Ten letters at a time, by whole characters: an emoji is never cut between two keys. */
  async function typeIn(
    page: Page,
    field: Locator,
    text: string,
    stop: () => ProfiToolError | null,
  ) {
    const cap = Math.max(1, Math.floor(typing.budgetMs / Math.max(text.length, 1)))
    const lines = text.split(/\r\n?|\n/)
    for (const [n, line] of lines.entries()) {
      // A line break goes in as inserted text: an Enter key might send the half-written message.
      if (n > 0) await page.keyboard.insertText('\n')
      for (const piece of typingChunks(line)) {
        // Between two pieces: the core may have hung up, the press deadline may have passed, the tab may be gone.
        const halt = stop()
        if (halt) throw halt
        await field.pressSequentially(piece, {
          delay: Math.min(Math.round(between(typing.charMs)), cap),
        })
      }
    }
  }

  /** The message box once more, with the text in the field (never the text itself): the button it shows now. */
  async function keepTypedMap(r: SendRuntime, page: Page) {
    if (typedMapKept) return
    try {
      const map = await readChatFormMap(page)
      if (!map) return
      await r.eyes.onRaw({
        kind: 'dom',
        url: anonymousChatUrl(page.url()),
        body: { ...map, typed: true },
        receivedAt: new Date().toISOString(),
      })
      typedMapKept = true
    } catch {}
  }

  /** After a press, or when a twin pressed: only a look whether the message is in the chat. */
  async function look(
    r: SendRuntime,
    t: Tab,
    i: SendMessageInput,
    after: string | null,
  ): Promise<SendMessageOutput> {
    try {
      const s = r.watch.state()
      if (s === 'dead' || s === 'banned' || !t.can()) throw stillUnknown()
      const page = await openChat(r, t, i.chat_id)
      const { messages } = await readStable(r, page, i.chat_id, false)
      const found = findSent(messages, i.text, after)
      if (!found) throw stillUnknown()
      return await keepResult(i, found.id)
    } catch {
      throw stillUnknown()
    }
  }

  async function keepResult(i: SendMessageInput, id: string): Promise<SendMessageOutput> {
    const out = { found_on_page: true, platform_message_id: id }
    // The message is in the chat: a database that fails now must not turn it into a failure. The press stays written
    // without an answer, and a repeat of the key finds the same bubble.
    await saveMessageResult(o.db, i.idempotency_key, out).catch(() => {})
    return out
  }

  async function send(
    r: SendRuntime,
    t: Tab,
    i: SendMessageInput,
    aborted: () => boolean,
    deadline: number,
  ): Promise<SendMessageOutput> {
    const page = await openChat(r, t, i.chat_id)
    const read = await readStable(r, page, i.chat_id, i.expect_last_message_id === null)
    // What the reading cannot be trusted for is the page's change, not the chat's: no bubble where the core saw some,
    // a side the node does not know, or bubbles without any words (the place of the text has moved).
    const bubbles = read.messages
    if (bubbles.length === 0 && i.expect_last_message_id !== null)
      throw fail(
        'LAYOUT_CHANGED',
        `В чате ${i.chat_id} не нашлось ни одного сообщения, а ядро видело ${i.expect_last_message_id}: страница читается не так, сообщение не набрано`,
      )
    if (bubbles.some((m) => m.author === 'unknown'))
      throw fail(
        'LAYOUT_CHANGED',
        'В чате есть сообщение неизвестной стороны, сообщение не набрано',
      )
    if (bubbles.length > 0 && bubbles.every((m) => m.text.trim() === ''))
      throw fail('LAYOUT_CHANGED', 'Сообщения чата прочитались без слов, сообщение не набрано')
    const last = bubbles.at(-1)?.id ?? null
    if (last !== i.expect_last_message_id)
      throw fail(
        'CHAT_CHANGED',
        `В чате ${i.chat_id} последнее сообщение ${last ?? 'пусто'}, а ядро видело ${i.expect_last_message_id ?? 'пусто'}: ничего не набрано`,
      )
    const field = page.locator(CHAT_INPUT).filter({ visible: true })
    const fields = await field.count()
    if (fields !== 1)
      throw fail(
        'LAYOUT_CHANGED',
        fields === 0
          ? 'Поля ввода сообщения на странице чата нет, сообщение не набрано'
          : 'Полей ввода сообщения несколько, сообщение не набрано',
      )

    // Anything that stops it before the press: the tab may have stopped being ours, the core may have hung up.
    const stop = (): ProfiToolError | null => {
      const s = r.watch.state()
      if (s === 'dead') return fail('SESSION_DEAD', 'Профи.ру разлогинил аккаунт')
      if (s === 'banned') return fail('BANNED', 'Профи.ру заблокировал профиль')
      if (!t.can())
        return fail(
          'RATE_LIMITED',
          'Вкладка аккаунта перестала ходить на сайт, сообщение не отправлено',
        )
      if (aborted()) return fail('RATE_LIMITED', 'Ядро перестало ждать, сообщение не отправлено')
      // Past the last moment to press nothing is pressed, and the core is told it may have to look: it has stopped
      // waiting by now, or is about to.
      if (Date.now() > deadline)
        return uncertain(
          'Срок нажатия прошёл, сообщение не отправлено: смотреть чат перед повтором',
        )
      return null
    }
    const early = stop()
    if (early) throw early

    const want = i.text.replace(/\r\n?/g, '\n')
    // From the written press on, the message may be in the chat: nothing is a plain failure any more.
    let pressed = false
    try {
      // Like a person: into the field, a look at the chat, then the words.
      await field.click({ timeout: 5000 })
      await sleep(between(typing.lookMs))
      if ((await field.inputValue()) !== '') await clearDraft(field)
      // The button before the words: a microphone while the field is empty (old Sara). It must change with the text.
      const button = field.locator(CHAT_SEND_PATH)
      const buttonNow = async () => {
        const n = await button.count()
        if (n !== 1)
          throw fail(
            'LAYOUT_CHANGED',
            n === 0
              ? 'Кнопки отправки у поля ввода нет, сообщение не отправлено'
              : 'Кнопок отправки несколько, сообщение не отправлено',
          )
        return button.evaluate((el) => el.outerHTML)
      }
      const emptyButton = await buttonNow()
      await typeIn(page, field, i.text, stop)
      let got = await field.inputValue()
      // The field did not take it as typed: old Sara's way, the whole text at once.
      if (got !== want) {
        await field.fill(want, { timeout: 5000 })
        got = await field.inputValue()
      }
      if (got !== want)
        throw fail('INTERNAL', 'Поле ввода не приняло текст целиком, сообщение не отправлено')
      await keepTypedMap(r, page)

      // Old Sara's button, with the text in the field now: its look (words, icon, classes) must differ from the
      // empty field's, or it may still be the microphone. A trial press first, nothing happens by it.
      if ((await buttonNow()) === emptyButton)
        throw fail(
          'LAYOUT_CHANGED',
          'Кнопка у поля не изменилась после набора текста (возможно, это микрофон), сообщение не отправлено',
        )
      try {
        await button.click({ trial: true, timeout: 5000 })
      } catch {
        throw fail('LAYOUT_CHANGED', 'Кнопку отправки нельзя нажать, сообщение не отправлено')
      }
      await sleep(between(typing.lookMs))
      const late = stop()
      if (late) throw late

      // The chat was read before the clicking, the pauses and the typing: it may have moved since. One more look,
      // right before the press (a client who wrote while the words were typed, Boris answering by hand).
      const fresh = await o.parsers.fromChatDom(page, i.chat_id, { waitMs: 0 })
      await r.eyes.onChatRead(i.chat_id, fresh).catch(() => {})
      const lastNow = messagesOf(fresh).at(-1)?.id ?? null
      if (lastNow !== i.expect_last_message_id || (await field.inputValue()) !== want)
        throw fail(
          'CHAT_CHANGED',
          `Пока набирался текст, чат ${i.chat_id} изменился (последнее сообщение ${lastNow ?? 'пусто'}): ничего не отправлено`,
        )

      // The press is written down before it happens: a retry, also after a restart, only looks.
      const written = await saveMessagePress(o.db, {
        key: i.idempotency_key,
        accountId: i.account_id,
        chatId: i.chat_id,
        expectLastMessageId: i.expect_last_message_id,
      })
      pressed = true
      if (!written) {
        await clearDraft(field)
        const twin = await findMessageAttempt(o.db, i.idempotency_key)
        if (twin?.result) return twin.result as SendMessageOutput
        return await look(r, t, i, twin?.expectLastMessageId ?? i.expect_last_message_id)
      }
      const watch = watchSend(page)
      try {
        await button.click({ timeout: 5000 })
      } catch {
        watch.stop()
        throw stillUnknown()
      }
      return await confirm(r, page, i, new Set(read.messages.map((m) => m.id)), watch)
    } catch (e) {
      if (e instanceof ProfiToolError) throw e
      if (pressed) throw stillUnknown()
      // A failure of the browser or the page before the press: nothing was sent.
      const why = e instanceof Error ? e.message.slice(0, 120) : String(e)
      throw fail('INTERNAL', `Сбой до нажатия, сообщение не отправлено: ${why}`)
    } finally {
      // Whatever stopped the message, a draft must not stay in the client's chat box. After the press only the
      // text itself is taken back out (a press that did nothing); anything else in the field is the site's.
      const left = await field.inputValue().catch(() => '')
      if (left !== '' && (!pressed || left === want)) await clearDraft(field)
    }
  }

  /**
   * How the bubble looks now: a mark of sending or of a refusal on it (never in the words it carries: a text may say
   * «ошибка»), or gone. Guessed from attributes, classes and the little words around the text until the live page
   * shows how a sending or refused bubble is drawn.
   */
  function bubbleState(page: Page, id: string): Promise<'ok' | 'pending' | 'failed' | 'gone'> {
    return page.evaluate(
      ({ bubble, id }) => {
        const el = [...document.querySelectorAll(bubble)].find(
          (e) => e.getAttribute('data-message-content-id') === id,
        )
        if (!el) return 'gone' as const
        const rest = el.cloneNode(true) as HTMLElement
        for (const t of rest.querySelectorAll('.cw_xeDn2R .cw_BFgZYK')) t.remove()
        const marks = [el, ...rest.querySelectorAll('*')]
          .flatMap((e) => [
            ...e.classList,
            ...[...e.attributes]
              .filter((a) => a.name !== 'data-message-content-id' && a.name !== 'class')
              .map((a) => `${a.name}=${a.value}`),
          ])
          .join(' ')
        const words = rest.textContent ?? ''
        if (/(error|fail|reject|retry|unsent|undeliver)/i.test(marks)) return 'failed' as const
        if (/(не отправлен|не доставлен|ошибк|повторить)/i.test(words)) return 'failed' as const
        if (/(pending|sending|aria-busy=true|loading|spinner)/i.test(marks))
          return 'pending' as const
        if (/отправляется/i.test(words)) return 'pending' as const
        return 'ok' as const
      },
      { bubble: BUBBLE, id },
    )
  }

  /**
   * What the page asks of the site after the press (a request that changes something: its way, its address without
   * numbers and query, the status of the answer), kept for calibrating the send. The site's own answer to the send
   * is not trusted yet: its address and shape are not known, only the page decides until a live capture shows them.
   */
  function watchSend(page: Page) {
    const requests: { method: string; path: string; status: number }[] = []
    const onResponse = (res: Response) => {
      try {
        const method = res.request().method()
        if (['GET', 'HEAD', 'OPTIONS'].includes(method) || requests.length >= 10) return
        requests.push({
          method,
          path: new URL(res.url()).pathname.replace(/\d{5,}/g, '0'),
          status: res.status(),
        })
      } catch {}
    }
    page.on('response', onResponse)
    return { requests, stop: () => void page.off('response', onResponse) }
  }

  /**
   * After the press: a new bubble of our side with this text that is not still sending or refused, and is still
   * there, under the same number, on a second look settleMs later; else UNCERTAIN (never a retry within confirmMs).
   * `before`: the bubbles that stood in the chat when it was read before typing; none of them is the new one.
   */
  async function confirm(
    r: SendRuntime,
    page: Page,
    i: SendMessageInput,
    before: Set<string>,
    watch: ReturnType<typeof watchSend>,
  ): Promise<SendMessageOutput> {
    const started = Date.now()
    const until = started + confirmMs
    const ours = (m: Seen) =>
      m.author === 'specialist' && normalizeText(m.text) === normalizeText(i.text)
    let sent: string | null = null
    try {
      for (;;) {
        try {
          const first = messagesOf(await o.parsers.fromChatDom(page, i.chat_id, { waitMs: 1000 }))
          const found = first.find((m) => ours(m) && !before.has(m.id))
          if (found && (await bubbleState(page, found.id)) === 'ok') {
            // One look is not enough: a bubble drawn at once may be taken back when the site refuses the message.
            await sleep(settleMs)
            const parsed = await o.parsers.fromChatDom(page, i.chat_id, { waitMs: 0 })
            const again = messagesOf(parsed).find((m) => m.id === found.id && ours(m))
            if (again && (await bubbleState(page, again.id)) === 'ok') {
              await r.eyes.onChatRead(i.chat_id, parsed).catch(() => {})
              sent = again.id
              break
            }
          }
        } catch {}
        if (Date.now() >= until) break
        await sleep(pollMs)
      }
    } finally {
      watch.stop()
      // For calibration only (the way and status of what the page asked, never a body or a text).
      await r.eyes
        .onRaw({
          kind: 'dom',
          url: anonymousChatUrl(page.url()),
          body: {
            what: 'chat_send',
            found: sent !== null,
            ms: Date.now() - started,
            requests: watch.requests,
          },
          receivedAt: new Date().toISOString(),
        })
        .catch(() => {})
    }
    if (sent === null) throw stillUnknown()
    return keepResult(i, sent)
  }

  /**
   * Work in the account tab in turn with the feed check and the chat walk. A call that waited longer than queueMs is
   * UNCERTAIN, and its work never starts later; so it is when the core hung up while the call waited (`skipped`).
   */
  function queued<T>(
    r: SendRuntime,
    aborted: () => boolean,
    work: (t: Tab) => Promise<T>,
    skipped: () => ProfiToolError,
  ): Promise<T> {
    let started = false
    let gaveUp = false
    // Every message here is one Boris approved or wrote: it goes before the checks waiting for the tab.
    const job = r.inTab(
      async (t) => {
        if (gaveUp || aborted()) throw skipped()
        started = true
        return work(t)
      },
      { urgent: true },
    )
    // The call may stop listening before the job ends; its failure is then nobody's.
    job.catch(() => {})
    let timer: NodeJS.Timeout | undefined
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (started) return
        gaveUp = true
        reject(
          uncertain('Вкладка аккаунта занята, сообщение не набрано: смотреть чат перед повтором'),
        )
      }, queueMs)
    })
    return Promise.race([job, tooLong]).finally(() => clearTimeout(timer))
  }

  return {
    async sendMessage(i, signal) {
      const m = { accountId: i.account_id, chatId: i.chat_id, text: i.text, key: i.idempotency_key }
      if (!verifyMessagePermit(o.permitSecret, m, i.permit))
        throw fail('INTERNAL', 'Разрешение ядра не подходит к сообщению')
      const r = runtime(i.account_id)
      const aborted = () => signal?.aborted === true
      const deadline = Date.now() + pressBudgetMs

      // A key seen before is answered from the database, never by a refusal: what it pressed may be in the chat, and
      // a plain failure here would send a person to type the same message again (as for submit_bid).
      const known = await findMessageAttempt(o.db, i.idempotency_key)
      if (known) {
        if (known.accountId !== i.account_id || known.chatId !== i.chat_id)
          throw fail('INTERNAL', 'Ключ повтора уже занят сообщением в другом чате или аккаунте')
        if (known.result) return known.result as SendMessageOutput
        // Pressed, no answer: only a look at the chat, and none at all while the switch is off or the session is down.
        const s = r.watch.state()
        if (!o.enabled || s === 'dead' || s === 'banned') throw stillUnknown()
        return queued(
          r,
          aborted,
          async (t) => {
            // A twin of this call may have found the message while this one waited for the tab.
            const twin = await findMessageAttempt(o.db, i.idempotency_key)
            if (twin?.result) return twin.result as SendMessageOutput
            return look(r, t, i, twin?.expectLastMessageId ?? known.expectLastMessageId)
          },
          stillUnknown,
        ).catch(() => {
          throw stillUnknown()
        })
      }

      if (!o.enabled) throw fail('INTERNAL', 'отправка сообщений выключена на службе')
      if (leaksProtocol(i.text))
        throw fail('INTERNAL', 'Текст похож на служебный (JSON или тег) и клиенту не уходит')
      requireAlive(r.watch)
      return queued(
        r,
        aborted,
        async (t) => {
          // A twin of this call may have pressed while this one waited for the tab.
          const twin = await findMessageAttempt(o.db, i.idempotency_key)
          if (twin?.result) return twin.result as SendMessageOutput
          if (twin) return look(r, t, i, twin.expectLastMessageId)
          requireAlive(r.watch)
          if (!t.can())
            throw fail(
              'RATE_LIMITED',
              'Вкладка аккаунта сейчас не ходит на сайт (живой экран, связь или IP), сообщение не набрано',
            )
          return send(r, t, i, aborted, deadline)
        },
        () => fail('RATE_LIMITED', 'Ядро перестало ждать, сообщение не набрано'),
      )
    },
  }
}
