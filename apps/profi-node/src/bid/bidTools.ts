import type {
  ClientInfo,
  GetOrderOutput,
  ProfiOrder,
  SubmitBidInput,
  SubmitBidOutput,
} from '@sara/shared'
import { normalizeText } from '@sara/shared'
import { verifyPermit } from '@sara/shared/permit'
import { eq } from 'drizzle-orm'
import type { Page, Request, Response } from 'playwright'
import type { NodeDb } from '../db/client'
import { bidAttempt } from '../db/schema'
import { clientInfoFromAnswer } from '../eyes/clientInfo'
import type { Eyes } from '../eyes/eyes'
import { readFormMap } from '../eyes/formMap'
import type { Insurance } from '../eyes/insurance'
import { pageShape } from '../eyes/pageShape'
import type { MessageSignal, Parsers } from '../eyes/parsers'
import { profiParsers } from '../eyes/profiParsers'
import { ProfiToolError, type ProfiToolsImpl } from '../mcp/server'
import {
  type BidAttempt,
  duesPressedAfter,
  findBidAttempt,
  markOrderBid,
  saveBidResult,
  savePress,
} from '../store/raw'
import { storedOrder } from '../tools/readTools'
import { requireAlive, type SessionState } from '../watch/sessionWatch'
import {
  clickSubmit,
  closedNotice,
  fillForm,
  formOnScreen,
  type OpenerMiss,
  openForm,
  readPayment,
} from './form'
import { type OrderScreen, orderScreenFromAnswer } from './screen'

export type BidRuntime = {
  watch: { state(): SessionState }
  eyes: Pick<Eyes, 'balance' | 'onParsed' | 'onRaw'>
  /** The account tab, in turn with the feed check; can() is false while the tab may not move or is not there. */
  inTab: Insurance['inTab']
  page(): Page
  /** On each order page get_order opened, while the tab is still there (the form calibration, src/bid). */
  afterOrderPage?(orderId: string, may: () => boolean): Promise<void>
}

type Go = (path: string, o?: { quick?: boolean }) => Promise<boolean>
const fail = (c: ConstructorParameters<typeof ProfiToolError>[0], m: string) =>
  new ProfiToolError(c, m)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** What the form did after the press, before the bid was looked for; `retry` is a later call that only looks. */
type AfterPress = {
  form: 'closed' | 'sent' | 'open' | 'paid' | 'unsure' | 'retry'
  /** The wallet right before the press; null: the wallet cannot confirm. */
  walletBefore: number | null
  /** Null: a retry whose press has no readable time. */
  pressedAt: number | null
}
/** What confirmed a bid. */
type BidSign = 'chat' | 'list' | 'page' | 'wallet'
const SIGN_WORDS: Record<BidSign, string> = {
  chat: 'в чате заказа',
  list: 'в списке чатов',
  page: 'на странице заказа',
  wallet: 'по кошельку',
}
/**
 * What is looked at after a press, in turn, while confirmMs lasts: about three pages at the live pace. The chat first:
 * our text is there about 3 s after the press (31.10.2026), while the order answer's hasBid took 3 to 8 minutes on the
 * first bids after #212. A retry looks at each once: the core calls it five times in half a minute.
 */
const LOOKS = ['chat', 'order', 'chat', 'order'] as const
const RETRY_LOOKS = ['chat', 'order'] as const
/** Site's clock against ours, for a chat's last message since the press. */
const CLOCKS_MS = 60_000

/** Our bid among a chat's texts: the whole text, or the first words of it when the page shows a long one cut. */
export function isOurBid(seen: string, text: string): boolean {
  const a = normalizeText(seen)
  const b = normalizeText(text)
  if (a === '' || b === '') return false
  return a === b || a.includes(b) || (a.length >= 40 && b.startsWith(a.slice(0, 40)))
}
/**
 * Where a bid call is and what it saw: the one line of the node's log a failure leaves, and the record of a page the
 * node could not read (31.10.2026, order 95590077: two refusals left no word of which check said no).
 */
type BidTrace = {
  step: string
  feeRub?: number | null
  walletRub?: number | null
  opener?: { why: OpenerMiss | null; shownRub: number | null } | null
}
const OPENER_WORDS: Record<OpenerMiss, string> = {
  no_opener: 'кнопки, которая открывает форму, на странице нет',
  opener_fee: 'сумма на «Продолжить» не та, что в заказе',
  two_openers: 'кнопок «Продолжить» несколько',
  opener_sends: 'кнопка открытия похожа на отправку',
  may_not: 'вкладке стало нельзя нажимать',
  no_field: 'после нажатия поле текста не появилось',
}
const FORM_WORDS: Record<AfterPress['form'], string> = {
  closed: 'форма закрылась',
  sent: 'сайт ответил на отправку, форма осталась',
  open: 'форма не закрылась',
  paid: 'кошелёк уже меньше',
  unsure: 'нажатие не подтвердилось',
  retry: 'повтор после нажатия',
}
/**
 * The wallet down by exactly the amount due, and what later presses took, since before the press (95611217: 3277 → 3110
 * at 167 ₽). Any other sum is someone else's money or a top-up: it proves nothing, and the chat is looked at instead.
 */
const moneyGone = (rub: number | null, before: number | null, due: number, later = 0) =>
  before !== null && due > 0 && rub !== null && rub === before - due - later
/** Waits ms without a page, stopping early when told. */
async function watchFor(ms: number, stop: () => boolean) {
  const until = Date.now() + ms
  while (Date.now() < until && !stop()) await sleep(Math.min(250, ms))
}

/**
 * The requests the press sent: all but GET (the form's send and what it sets off). Settled once there were some and
 * the site answered every one of them half a second ago or more; one that polls for long keeps it unsettled.
 */
function watchSend(page: Page) {
  const open = new Set<Request>()
  let seen = 0
  let lastAt = 0
  const onRequest = (q: Request) => {
    if (q.method() === 'GET') return
    open.add(q)
    seen++
  }
  const onDone = (q: Request) => {
    if (open.delete(q)) lastAt = Date.now()
  }
  page.on('request', onRequest)
  page.on('requestfinished', onDone)
  page.on('requestfailed', onDone)
  return {
    settled: () => seen > 0 && open.size === 0 && Date.now() - lastAt >= 500,
    stop() {
      page.off('request', onRequest)
      page.off('requestfinished', onDone)
      page.off('requestfailed', onDone)
    },
  }
}

/**
 * profi.get_order and profi.submit_bid on the site itself (FR-LEAD-5, FR-LEAD-8, NFR-REL-4, M2 design 5.B). The order
 * page is opened in the account tab only when it may move; its own answer says whether the order is open, what a bid
 * costs and whether this account already bid. A bid counts only when the form closed and a fresh read of that
 * answer shows it. A press is written down before it happens: after it, a call with the same key only looks.
 */
export function createBidTools(o: {
  db: NodeDb
  permitSecret: string
  parsers: Parsers
  accounts: Map<string, BidRuntime>
  answerMs?: number
  closeMs?: number
  /** The pause before the order page is looked at once more after a press it did not show yet. */
  lookAgainMs?: number
  /** How long after the press the bid is looked for before the press is UNCERTAIN. */
  confirmMs?: number
  /** How long one look stays on the chat page: the messenger brings new messages itself. */
  chatLookMs?: number
  /** How long one look at the order page waits for its answer. */
  orderLookMs?: number
  /** A retry opens no page this soon after the last look at the same bid: the core calls it five times in 30 s. */
  retryLookMs?: number
  /** How long get_order waits for the client answer once the page has loaded. */
  clientMs?: number
}): Pick<ProfiToolsImpl, 'getOrder' | 'submitBid'> {
  // As long as a page load may take (30 s to load, 10 s to settle): a slow page is not a changed site.
  const answerMs = o.answerMs ?? 45000
  const closeMs = o.closeMs ?? 15000
  const lookAgainMs = o.lookAgainMs ?? 5000
  // Boris, 31.10.2026: «Медленно этот процесс работает!» A bid taken at 09:17:53 was UNCERTAIN at 09:19:04 and found
  // only by the core's later look: the order answer showed it minutes late. The page is looked at until this passes.
  const confirmMs = o.confirmMs ?? 30000
  const chatLookMs = o.chatLookMs ?? 6000
  const orderLookMs = o.orderLookMs ?? 8000
  const retryLookMs = o.retryLookMs ?? 10000
  // When each unsure bid was last looked at.
  const lookedAt = new Map<string, number>()
  const clientMs = o.clientMs ?? 3000
  const orderPath = o.parsers.paths.order ?? profiParsers.paths.order ?? ((id) => id)
  const uncertain = () => fail('UNCERTAIN', 'Отклик нажат, но страница его не показала')
  /**
   * An unsure press, with why in the node's log (30.10.2026: three bids of five on 28.10 were unsure, and the log could
   * not tell a form that stayed open from an order page that did not show the bid yet).
   */
  const told = new WeakSet<Error>()
  const unsure = (orderId: string, why: string) => {
    console.error(`UNCERTAIN ${orderId}: ${why}`)
    const e = uncertain()
    told.add(e)
    return e
  }
  /** One line of the node's log per failed bid: the class, the step and the message (an unsure one has its own). */
  function logFailure(orderId: string, trace: BidTrace, e: unknown) {
    if (e instanceof Error && told.has(e)) return
    const cls = e instanceof ProfiToolError ? e.errorClass : 'INTERNAL'
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e)
    const saw = [
      trace.feeRub != null ? `цена ${trace.feeRub} ₽` : null,
      trace.walletRub != null ? `кошелёк ${trace.walletRub} ₽` : null,
    ].filter(Boolean)
    console.error(
      `BID ${orderId} ${cls} на шаге «${trace.step}»: ${msg}${saw.length ? ` (${saw.join(', ')})` : ''}`,
    )
  }
  /**
   * A bid refused for a page the node could not read: what the node saw and the page's outline (tags and classes,
   * never its text) are kept in node.raw_event, so the next look tells which part of the page changed.
   */
  async function keepRefusal(r: BidRuntime, orderId: string, trace: BidTrace, message: string) {
    const page = r.page()
    const shape = await pageShape(page).catch(() => [])
    await r.eyes
      .onRaw({
        kind: 'dom',
        url: page.url(),
        body: {
          what: 'bid_refused',
          orderId,
          step: trace.step,
          message,
          feeRub: trace.feeRub ?? null,
          walletRub: trace.walletRub ?? null,
          opener: trace.opener ?? null,
          shape,
        },
        receivedAt: new Date().toISOString(),
      })
      .catch(() => {})
  }
  const tooLate = () =>
    fail('RATE_LIMITED', 'Срок нажатия прошёл или ядро перестало ждать, отклик не нажат')
  const dearer = (due: number, max: number) =>
    fail('PRICE_CHANGED', `Отклик стоит ${due} ₽, а ядро разрешило до ${max} ₽, отклик не нажат`)

  const runtime = (id: string) => {
    const r = o.accounts.get(id)
    if (!r) throw fail('NOT_FOUND', `account ${id} is not served here`)
    return r
  }

  /**
   * The client answer (getKlientInfo) of the order page open now. It counts only when the page that asked is this
   * order's own (the address of the frame that made the request), and only while this visit lasts.
   */
  function watchClient(page: Page, orderId: string) {
    let found: ClientInfo | null = null
    let arrived: (c: ClientInfo) => void = () => {}
    const first = new Promise<ClientInfo>((r) => {
      arrived = r
    })
    const onResponse = async (res: Response) => {
      try {
        if (found || !/\/backoffice\/api\//.test(new URL(res.url()).pathname)) return
        const from = res.request().frame()?.url()
        if (!from || new URL(from).searchParams.get('o') !== orderId) return
        const info = clientInfoFromAnswer(await res.json().catch(() => null))
        if (!info || found) return
        found = info
        arrived(info)
      } catch {}
    }
    page.on('response', onResponse)
    return {
      /** The answer, waiting at most `ms` for it; null when none came. */
      async result(ms: number): Promise<ClientInfo | null> {
        if (found) return found
        let timer: NodeJS.Timeout | undefined
        const late = new Promise<null>((r) => {
          timer = setTimeout(() => r(null), ms)
        })
        try {
          return await Promise.race([first, late])
        } finally {
          clearTimeout(timer)
        }
      },
      stop: () => void page.off('response', onResponse),
    }
  }

  /**
   * Opens the order page and waits for its own answer about this order (null when none came). With `client` it
   * also takes the client answer of this visit.
   */
  async function openOrder(
    page: Page,
    go: Go,
    orderId: string,
    client = false,
    look?: { answerMs: number },
  ) {
    const answer = page
      .waitForResponse(
        // Only GraphQL bodies are read: images and scripts of the page pass by untouched.
        async (res) =>
          /\/graphql/.test(res.url()) &&
          orderScreenFromAnswer(res.url(), await res.json().catch(() => null), orderId) !== null,
        { timeout: look?.answerMs ?? answerMs },
      )
      .then(async (res) => orderScreenFromAnswer(res.url(), await res.json(), orderId))
      .catch(() => null)
    const watch = client ? watchClient(page, orderId) : null
    try {
      if (!(await go(orderPath(orderId), { quick: look !== undefined })))
        return { ok: false, screen: null, client: null }
      const screen = await answer
      return { ok: true, screen, client: (await watch?.result(clientMs)) ?? null }
    } finally {
      watch?.stop()
    }
  }

  /** The wallet in the top bar of this page; null when the bar shows none. */
  async function headerWallet(page: Page): Promise<number | null> {
    const signals = await o.parsers.fromHeaderDom(page).catch(() => [])
    const rub = signals.find((s) => s.t === 'balance')
    return rub && rub.t === 'balance' ? rub.rub : null
  }

  /** The wallet in the top bar of this page, told to the eyes too; null when the bar shows none. */
  async function walletOnPage(r: BidRuntime, page: Page): Promise<number | null> {
    const signals = await o.parsers.fromHeaderDom(page).catch(() => [])
    await r.eyes.onParsed({ recognized: false, signals }, 'dom')
    const rub = signals.find((s) => s.t === 'balance')
    return rub && rub.t === 'balance' ? rub.rub : null
  }

  /**
   * After the press: the wallet the eyes hear is down already (`paid`), the form closed, or the site answered all the
   * press sent (31.10.2026 the form stayed open 30 s while the money was already gone). At most ms; 'open' when neither.
   */
  async function waitSent(
    page: Page,
    send: ReturnType<typeof watchSend>,
    ms: number,
    paid: () => boolean,
  ): Promise<AfterPress['form']> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (paid()) return 'paid'
      if (!(await formOnScreen(page).catch(() => true))) return 'closed'
      if (send.settled()) return 'sent'
      await sleep(250)
    }
    return 'open'
  }

  async function keepFormMap(r: BidRuntime, page: Page) {
    const body = await readFormMap(page)
    if (body)
      await r.eyes
        .onRaw({ kind: 'dom', url: page.url(), body, receivedAt: new Date().toISOString() })
        .catch(() => {})
  }

  /**
   * The order's chat after a press: one page load, watched for chatLookMs, since the messenger page brings new messages
   * itself. Our text in its bubbles or its answer is the bid; so is this order's line in the chats list with a message
   * since the press (`since`, null for a retry that knows no press). The note for the log holds counts, never a word.
   */
  async function lookInChat(
    page: Page,
    t: { go: Go },
    i: SubmitBidInput,
    since: number | null,
  ): Promise<{ by: BidSign | null; note: string }> {
    let answered = 0
    let inAnswer = false
    let listed = false
    const onResponse = async (res: Response) => {
      if (!['fetch', 'xhr'].includes(res.request().resourceType())) return
      try {
        const body = await res.json()
        const texts = o.parsers.chatTextsFromAnswer?.(res.url(), body) ?? null
        if (texts) {
          answered += texts.length
          if (texts.some((x) => isOurBid(x, i.text))) inAnswer = true
        }
        const line = o.parsers
          .chatsFromAnswer?.(res.url(), body)
          ?.find((c) => c.chatId === i.order_id)
        if (since !== null && line?.lastAt && Date.parse(line.lastAt) >= since - CLOCKS_MS)
          listed = true
      } catch {}
    }
    page.on('response', onResponse)
    try {
      if (!(await t.go(o.parsers.paths.chat(i.order_id), { quick: true })))
        return { by: null, note: 'чат не открылся' }
      const until = Date.now() + chatLookMs
      let bubbles = 0
      for (;;) {
        const read = await o.parsers
          .fromChatDom(page, i.order_id, { waitMs: 300 })
          .catch(() => null)
        const msgs = (read?.signals ?? []).filter((x): x is MessageSignal => x.t === 'message')
        bubbles = msgs.length
        const inBubble = msgs.some(
          (x) => x.message.author !== 'client' && isOurBid(x.message.text, i.text),
        )
        if (inBubble || inAnswer)
          return { by: 'chat', note: `чат: отклик есть, ${inBubble ? 'пузырь' : 'ответ'}` }
        if (listed) return { by: 'list', note: 'чат: новая строка в списке' }
        if (Date.now() >= until) break
        await sleep(300)
      }
      return { by: null, note: `чат: отклика нет, пузырей ${bubbles}, в ответе ${answered}` }
    } finally {
      page.off('response', onResponse)
    }
  }

  /** The order page after a press: its answer's hasBid and the wallet in its top bar, once the bar is drawn. */
  async function lookAtOrder(page: Page, t: { go: Go }, orderId: string) {
    const again = await openOrder(page, t.go, orderId, false, { answerMs: orderLookMs })
    if (!again.ok) return { hasBid: null, wallet: null, note: 'заказ не открылся' }
    let wallet = await headerWallet(page)
    for (let k = 0; k < 8 && wallet === null; k++) {
      await sleep(250)
      wallet = await headerWallet(page)
    }
    const hasBid = again.screen ? again.screen.hasBid : null
    return {
      hasBid,
      wallet,
      note: `заказ: ${again.screen ? `hasBid ${hasBid}` : 'ответа нет'}, кошелёк ${wallet ?? 'не виден'}`,
    }
  }

  /** What a call that comes after the press knows of it, from the press written down. */
  function retryOf(a: BidAttempt | null): AfterPress {
    const at = a ? Date.parse(a.pressedAt) : Number.NaN
    return {
      form: 'retry',
      walletBefore: a?.walletRub ?? null,
      pressedAt: Number.isNaN(at) ? null : at,
    }
  }

  /**
   * After a press only a look: a sign of the bid is that press and its money; no sign is UNCERTAIN. The signs, by what
   * the live site gives first: the wallet the eyes hear, down by exactly the amount due since before the press (it costs no
   * page and needs no tab: 95611217 showed it 2 s after the press); our text in the order's chat; this order's fresh
   * line in the chats list; the order answer's hasBid; the wallet in the order page's top bar. found_on_page is true
   * for the chat and the order page, which show the bid itself. The log line says what each look saw, so a sign that
   * lags can be told from one not read.
   */
  async function confirm(
    r: BidRuntime,
    i: SubmitBidInput,
    dueRub: number,
    t: { go: Go; can(): boolean },
    after: AfterPress,
  ): Promise<SubmitBidOutput> {
    const form = FORM_WORDS[after.form]
    const before = after.walletBefore
    const retry = after.form === 'retry'
    const started = Date.now()
    const took = () => Math.round((Date.now() - (after.pressedAt ?? started)) / 1000)
    const trail: string[] = []
    const looks = () =>
      [
        ...trail,
        `кошелёк до нажатия ${before ?? 'неизвестен'}`,
        `глаза слышат ${r.eyes.balance() ?? 'ничего'}`,
      ].join('; ')
    try {
      const page = r.page()
      // A press made after this one may have taken money too: it is not this press's.
      const later = retry ? await duesPressedAfter(o.db, i.account_id, i.idempotency_key) : 0
      const paid = (rub: number | null) => moneyGone(rub, before, dueRub, later)
      const heard = () => paid(r.eyes.balance())
      // The core calls a retry five times in half a minute: pages only now and then, the wallet every time.
      const justLooked = retry && Date.now() - (lookedAt.get(i.idempotency_key) ?? 0) < retryLookMs
      let by: BidSign | null = null
      for (const [k, look] of (retry ? RETRY_LOOKS : LOOKS).entries()) {
        if (k > 0) {
          if (Date.now() - started + lookAgainMs > confirmMs) break
          await watchFor(lookAgainMs, heard)
        }
        if (heard()) {
          by = 'wallet'
          break
        }
        const s = r.watch.state()
        if (s === 'dead' || s === 'banned') break
        // No page may be opened now; the wallet is still heard until the time is out.
        if (!t.can()) {
          trail.push('вкладке нельзя ходить')
          continue
        }
        if (justLooked) {
          trail.push('смотрели только что')
          break
        }
        if (look === 'chat') {
          const seen = await lookInChat(page, t, i, after.pressedAt)
          trail.push(seen.note)
          by = seen.by
        } else {
          const seen = await lookAtOrder(page, t, i.order_id)
          trail.push(seen.note)
          by = seen.hasBid === true ? 'page' : paid(seen.wallet) ? 'wallet' : null
        }
        lookedAt.delete(i.idempotency_key)
        if (lookedAt.size >= 100) lookedAt.delete(lookedAt.keys().next().value ?? '')
        lookedAt.set(i.idempotency_key, Date.now())
        if (by) break
      }
      if (!by && heard()) by = 'wallet'
      if (!by) throw unsure(i.order_id, `${form}, за ${took()} с признаков отклика нет; ${looks()}`)
      await markOrderBid(o.db, i.account_id, i.order_id)
      // Read only: the bar may not show the money gone yet, and the eyes must not hear the old wallet back from it. The
      // bid is there, so the money is gone.
      const shown = await headerWallet(page)
      console.error(
        `BID ${i.order_id}: подтверждён ${SIGN_WORDS[by]} через ${took()} с, ${form}; ${looks()}; в шапке сейчас ${shown ?? 'не виден'}`,
      )
      const out = {
        found_on_page: by === 'chat' || by === 'page',
        spent_rub: dueRub,
        balance_after_rub:
          before !== null
            ? Math.min(shown ?? before, before - dueRub)
            : (shown ?? r.eyes.balance()),
      }
      await saveBidResult(o.db, i.idempotency_key, out)
      lookedAt.delete(i.idempotency_key)
      return out
    } catch (e) {
      if (e instanceof ProfiToolError) throw e
      throw unsure(i.order_id, `${form}, страница не прочиталась; ${looks()}`)
    }
  }

  async function bid(
    r: BidRuntime,
    i: SubmitBidInput,
    t: { go: Go; can(): boolean },
    late: () => boolean,
    trace: BidTrace,
  ): Promise<SubmitBidOutput> {
    const page = r.page()
    const id = i.order_id
    const key = i.idempotency_key
    trace.step = 'страница заказа'
    const opened = await openOrder(page, t.go, id)
    if (!opened.ok) throw fail('RATE_LIMITED', 'Страница заказа не открылась, отклик не нажат')
    await keepFormMap(r, page)
    const s: OrderScreen | null = opened.screen
    if (!s) {
      if (await closedNotice(page)) throw fail('ORDER_CLOSED', 'Заказ больше не принимает отклики')
      throw fail('LAYOUT_CHANGED', 'Страница заказа не дала свой ответ, отклик не нажат')
    }
    trace.feeRub = s.feeRub
    trace.step = 'кошелёк в шапке'
    // Before any money only the wallet the page itself shows counts, never one remembered.
    const wallet = await walletOnPage(r, page)
    trace.walletRub = wallet
    trace.step = 'ответ страницы заказа'
    if (s.hasBid === true) {
      await markOrderBid(o.db, i.account_id, id)
      return {
        found_on_page: true,
        spent_rub: 0,
        balance_after_rub: wallet ?? r.eyes.balance(),
        already_there: true,
      }
    }
    if (s.hasBid === null)
      throw fail('LAYOUT_CHANGED', 'Ответ страницы не говорит, был ли отклик, отклик не нажат')
    if (!s.open) throw fail('ORDER_CLOSED', 'Заказ больше не принимает отклики')
    const price = i.price_rub ?? null
    if (s.priceRequired && price === null)
      throw fail('INTERNAL', 'Профи.ру требует «Стоимость услуги», а цены в отклике нет')
    if (s.feeRub === null)
      throw fail('LAYOUT_CHANGED', 'Не прочитал цену отклика в ответе страницы, отклик не нажат')
    if (wallet === null)
      throw fail('LAYOUT_CHANGED', 'Не прочитал кошелёк в шапке страницы, отклик не нажат')
    if (s.feeRub > i.max_fee_rub) throw dearer(s.feeRub, i.max_fee_rub)
    if (wallet < s.feeRub)
      throw fail('NO_MONEY', `В кошельке ${wallet} ₽, а отклик стоит ${s.feeRub} ₽`)
    if (s.payment === 'other')
      throw fail('UNSAFE_PAYMENT', 'Профи.ру просит оплату не с кошелька, отклик не нажат')
    if (late()) throw tooLate()

    // The press is written down before the opener: should the opener spend after all, a retry only looks.
    const pressed = await savePress(o.db, {
      key,
      accountId: i.account_id,
      orderId: id,
      dueRub: s.feeRub,
      walletRub: wallet,
    })
    if (!pressed) {
      const twin = await findBidAttempt(o.db, key)
      return confirm(r, i, twin?.dueRub ?? s.feeRub, t, retryOf(twin))
    }
    let openerPressed = false
    /**
     * A stop before the send button: the written press goes, so a retry may try again, but only when the opener was
     * not pressed or the wallet on the page shows nothing spent. Anything else may have spent: UNCERTAIN.
     */
    const refuse = async (e: ProfiToolError): Promise<never> => {
      const now = openerPressed ? await walletOnPage(r, page).catch(() => null) : wallet
      if (now !== wallet) throw uncertain()
      await o.db.delete(bidAttempt).where(eq(bidAttempt.idempotencyKey, key))
      throw e
    }
    const stopped = () =>
      !t.can()
        ? fail('RATE_LIMITED', 'Вкладка аккаунта перестала ходить на сайт, отклик не нажат')
        : late()
          ? tooLate()
          : null

    let due = s.feeRub
    try {
      trace.step = 'кнопка открытия формы'
      // «Продолжить» is pressed only beside the order's own fee, checked above against max_fee_rub.
      const form = await openForm(page, { words: s.openerText, feeRub: s.feeRub }, undefined, {
        may: () => t.can() && !late(),
        card: true,
      })
      openerPressed = form.pressed
      trace.opener = { why: form.why ?? null, shownRub: form.shownRub ?? null }
      if (!form.open) {
        const why =
          form.why === 'opener_fee'
            ? `на «Продолжить» ${form.shownRub} ₽, а в заказе ${s.feeRub} ₽`
            : form.why
              ? OPENER_WORDS[form.why]
              : 'причина не видна'
        return await refuse(
          stopped() ??
            fail('LAYOUT_CHANGED', `Форма отклика не открылась: ${why}, отклик не нажат`),
        )
      }
      trace.step = 'оплата в форме'
      const pay = await readPayment(page, wallet)
      due = pay.dueRub ?? s.feeRub
      if (due > i.max_fee_rub) return await refuse(dearer(due, i.max_fee_rub))
      if (wallet < due)
        return await refuse(fail('NO_MONEY', `В кошельке ${wallet} ₽, а к оплате ${due} ₽`))
      if (pay.way === 'other') {
        // The footer's own words (amounts and the way only) say which way it was, so a new wallet label can be taught.
        const words = pay.wayText ?? 'способ не показан'
        console.error(
          `UNSAFE_PAYMENT ${id}: в форме «${words}», к оплате ${due} ₽, в кошельке ${wallet} ₽`,
        )
        return await refuse(
          fail(
            'UNSAFE_PAYMENT',
            `Профи.ру просит оплату не с кошелька («${words}»), отклик не нажат`,
          ),
        )
      }
      trace.step = 'поля формы'
      const filled = await fillForm(page, {
        priceRub: price,
        priceToRub: i.price_to_rub ?? null,
        text: i.text,
      })
      if (filled === 'no_field')
        return await refuse(fail('LAYOUT_CHANGED', 'Поля формы отклика не нашлись'))
      if (filled === 'not_taken')
        return await refuse(
          fail('INTERNAL', 'Форма не приняла цену или текст целиком, отклик не нажат'),
        )
      const stop = stopped()
      if (stop) return await refuse(stop)
      if (due !== s.feeRub)
        await o.db.update(bidAttempt).set({ dueRub: due }).where(eq(bidAttempt.idempotencyKey, key))
    } catch (e) {
      if (e instanceof ProfiToolError) throw e
      const why = e instanceof Error ? e.message.slice(0, 120) : String(e)
      return refuse(fail('INTERNAL', `Сбой до нажатия, отклик не нажат: ${why}`))
    }

    // From here the bid may be on the site: anything not confirmed is UNCERTAIN, never a failure.
    let after: AfterPress
    // The wallet the press is measured against: the lowest of the one before the opener, the one the bar shows now and
    // the one the eyes heard last, so money an opener took, or an old wallet the eyes remember, is never this press's.
    const before = Math.min(
      ...[wallet, await headerWallet(page), r.eyes.balance()].filter((x) => x !== null),
    )
    if (before !== wallet)
      await o.db
        .update(bidAttempt)
        .set({ walletRub: before })
        .where(eq(bidAttempt.idempotencyKey, key))
        .catch(() => {})
    const send = watchSend(page)
    trace.step = 'нажатие «Откликнуться»'
    try {
      const clicked = await clickSubmit(page, s.submitText)
      // Nothing was pressed after all.
      if (clicked === 'no_button')
        return await refuse(fail('LAYOUT_CHANGED', 'Кнопки отправки отклика нет'))
      const pressedAt = Date.now()
      // The page is left only once the form closed or the site answered the send, so a slow send is never cut off;
      // then it is looked at whatever the form did (a bid there is this press; the page before the press had none). A
      // press that may not have happened is looked for all the same.
      const form =
        clicked === 'unsure'
          ? 'unsure'
          : await waitSent(page, send, 2 * closeMs, () => moneyGone(r.eyes.balance(), before, due))
      after = { form, walletBefore: before, pressedAt }
    } catch (e) {
      if (e instanceof ProfiToolError) throw e
      throw unsure(id, 'сбой после нажатия')
    } finally {
      send.stop()
    }
    trace.step = 'проверка после нажатия'
    return confirm(r, i, due, t, after)
  }

  return {
    async getOrder({ account_id, order_id }): Promise<GetOrderOutput> {
      const r = runtime(account_id)
      requireAlive(r.watch)
      const read = await r.inTab(
        async ({ go, can, later }) => {
          if (!can()) return null
          const page = r.page()
          const opened = await openOrder(page, go, order_id, true)
          if (!opened.ok) return null
          const known = await storedOrder(o.db, account_id, order_id).then(
            (x) => x,
            () => null,
          )
          // Closed only on the site's own word: a disabled bid block in the order answer, the bare answer of an order
          // the client closed (no form, tariff or price, and no bid of ours), or, when the page gave no answer, a
          // notice on the page. A missing form alone can be a changed layout or a bid already made.
          const closed = opened.screen
            ? opened.screen.disabled || opened.screen.bare
            : await closedNotice(page)
          const read = opened.screen !== null || closed
          // The page text is read for what the board did not show (a card without the text, or without any client
          // name), and for an order the eyes never stored; the client answer already carries a name.
          let fromPage: ProfiOrder | null = null
          if (
            o.parsers.fromOrderDom &&
            (!known || !known.text || (!known.client_name && !opened.client?.name))
          ) {
            const parsed = await o.parsers.fromOrderDom(page, order_id)
            if (!known) await r.eyes.onParsed(parsed, 'dom')
            const sig = parsed.signals.find((x) => x.t === 'order')
            fromPage = sig?.t === 'order' ? sig.order : null
          }
          if (opened.screen?.hasBid) await markOrderBid(o.db, account_id, order_id)
          // The form map and the calibration need this page, but not the caller's wait.
          later(async () => {
            await keepFormMap(r, page)
            if (r.afterOrderPage && can()) await r.afterOrderPage(order_id, can)
          })
          return { screen: opened.screen, closed, read, client: opened.client, fromPage }
          // The core waits for this page (its fee and whether the order is open go on the card): before the checks.
        },
        { soon: true, what: 'страница заказа' },
      )
      const stored = await storedOrder(o.db, account_id, order_id)
      if (!read) return stored
      const { screen, closed, client, fromPage } = read
      return {
        ...stored,
        // What the board showed comes first; the page and the client answer fill what it lacked.
        client_name: stored.client_name || fromPage?.client_name || client?.name || '',
        text: stored.text || fromPage?.text || '',
        open: read.read ? !closed : stored.open,
        bid_price_rub: screen?.feeRub ?? (stored.bid_price_rub || fromPage?.bid_price_rub || 0),
        has_bid: screen?.hasBid ?? stored.has_bid,
        client_info: client,
        from_page: read.read,
        attachments: screen?.attachments ?? [],
      }
    },

    async submitBid(i, signal) {
      const trace: BidTrace = { step: 'разрешение ядра' }
      try {
        return await submit(i, signal, trace)
      } catch (e) {
        logFailure(i.order_id, trace, e)
        throw e
      }
    },
  }

  async function submit(
    i: SubmitBidInput,
    signal: AbortSignal | undefined,
    trace: BidTrace,
  ): Promise<SubmitBidOutput> {
    if (!verifyPermit(o.permitSecret, i))
      throw fail('INTERNAL', 'Разрешение ядра не подходит к отклику')
    // The core stopped waiting (the call was cancelled) or the permit's deadline passed: no press any more.
    const late = () => signal?.aborted === true || Date.now() > Date.parse(i.not_after)
    const r = runtime(i.account_id)
    const known = await findBidAttempt(o.db, i.idempotency_key)
    if (known?.result) return known.result as SubmitBidOutput
    if (known) {
      trace.step = 'повтор после нажатия'
      return r
        .inTab((t) => confirm(r, i, known.dueRub, t, retryOf(known)), { urgent: true })
        .catch((e) => Promise.reject(e instanceof ProfiToolError ? e : uncertain()))
    }
    if (late()) throw tooLate()
    trace.step = 'вход на Профи.ру'
    requireAlive(r.watch)
    trace.step = 'очередь вкладки'
    return r.inTab(
      async (t) => {
        // A twin of this call may have pressed while this one waited for the tab.
        const twin = await findBidAttempt(o.db, i.idempotency_key)
        if (twin?.result) return twin.result as SubmitBidOutput
        if (twin) return confirm(r, i, twin.dueRub, t, retryOf(twin))
        if (late()) throw tooLate()
        requireAlive(r.watch)
        if (!t.can())
          throw fail(
            'RATE_LIMITED',
            'Вкладка аккаунта сейчас не ходит на сайт (живой экран, связь или IP), отклик не нажат',
          )
        try {
          return await bid(r, i, t, late, trace)
        } catch (e) {
          if (e instanceof ProfiToolError) {
            // The tab is still on the order page: its outline shows what the node could not read.
            if (e.errorClass === 'LAYOUT_CHANGED')
              await keepRefusal(r, i.order_id, trace, e.message)
            throw e
          }
          // A failure of our own before the press (the database, the browser): nothing was pressed.
          const why = e instanceof Error ? e.message.slice(0, 120) : String(e)
          throw fail('INTERNAL', `Сбой до нажатия, отклик не нажат: ${why}`)
        }
      },
      { urgent: true },
    )
  }
}
