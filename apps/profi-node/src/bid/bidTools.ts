import type {
  ClientInfo,
  GetOrderOutput,
  ProfiOrder,
  SubmitBidInput,
  SubmitBidOutput,
} from '@sara/shared'
import { verifyPermit } from '@sara/shared/permit'
import { eq } from 'drizzle-orm'
import type { Page, Response } from 'playwright'
import type { NodeDb } from '../db/client'
import { bidAttempt } from '../db/schema'
import { clientInfoFromAnswer } from '../eyes/clientInfo'
import type { Eyes } from '../eyes/eyes'
import { readFormMap } from '../eyes/formMap'
import type { Insurance } from '../eyes/insurance'
import type { Parsers } from '../eyes/parsers'
import { profiParsers } from '../eyes/profiParsers'
import { ProfiToolError, type ProfiToolsImpl } from '../mcp/server'
import { findBidAttempt, markOrderBid, saveBidResult, savePress } from '../store/raw'
import { storedOrder } from '../tools/readTools'
import { requireAlive, type SessionState } from '../watch/sessionWatch'
import { clickSubmit, closedNotice, fillForm, openForm, readPayment, waitFormClosed } from './form'
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

type Go = (path: string) => Promise<boolean>
const fail = (c: ConstructorParameters<typeof ProfiToolError>[0], m: string) =>
  new ProfiToolError(c, m)

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
  /** How long get_order waits for the client answer once the page has loaded. */
  clientMs?: number
}): Pick<ProfiToolsImpl, 'getOrder' | 'submitBid'> {
  // As long as a page load may take (30 s to load, 10 s to settle): a slow page is not a changed site.
  const answerMs = o.answerMs ?? 45000
  const closeMs = o.closeMs ?? 15000
  const clientMs = o.clientMs ?? 3000
  const orderPath = o.parsers.paths.order ?? profiParsers.paths.order ?? ((id) => id)
  const uncertain = () => fail('UNCERTAIN', 'Отклик нажат, но страница его не показала')

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
  async function openOrder(page: Page, go: Go, orderId: string, client = false) {
    const answer = page
      .waitForResponse(
        // Only GraphQL bodies are read: images and scripts of the page pass by untouched.
        async (res) =>
          /\/graphql/.test(res.url()) &&
          orderScreenFromAnswer(res.url(), await res.json().catch(() => null), orderId) !== null,
        { timeout: answerMs },
      )
      .then(async (res) => orderScreenFromAnswer(res.url(), await res.json(), orderId))
      .catch(() => null)
    const watch = client ? watchClient(page, orderId) : null
    try {
      if (!(await go(orderPath(orderId)))) return { ok: false, screen: null, client: null }
      const screen = await answer
      return { ok: true, screen, client: (await watch?.result(clientMs)) ?? null }
    } finally {
      watch?.stop()
    }
  }

  /** The wallet in the top bar of this page, told to the eyes too; null when the bar shows none. */
  async function walletOnPage(r: BidRuntime, page: Page): Promise<number | null> {
    const signals = await o.parsers.fromHeaderDom(page).catch(() => [])
    await r.eyes.onParsed({ recognized: false, signals }, 'dom')
    const rub = signals.find((s) => s.t === 'balance')
    return rub && rub.t === 'balance' ? rub.rub : null
  }

  async function keepFormMap(r: BidRuntime, page: Page) {
    const body = await readFormMap(page)
    if (body)
      await r.eyes
        .onRaw({ kind: 'dom', url: page.url(), body, receivedAt: new Date().toISOString() })
        .catch(() => {})
  }

  /** After a press only a look: the bid on the page is that press and its money; anything else is UNCERTAIN. */
  async function confirm(
    r: BidRuntime,
    i: SubmitBidInput,
    dueRub: number,
    t: { go: Go; can(): boolean },
  ): Promise<SubmitBidOutput> {
    try {
      const s = r.watch.state()
      if (s === 'dead' || s === 'banned' || !t.can()) throw uncertain()
      const page = r.page()
      const again = await openOrder(page, t.go, i.order_id)
      if (again.screen?.hasBid !== true) throw uncertain()
      await markOrderBid(o.db, i.account_id, i.order_id)
      const out = {
        found_on_page: true,
        spent_rub: dueRub,
        balance_after_rub: (await walletOnPage(r, page)) ?? r.eyes.balance(),
      }
      await saveBidResult(o.db, i.idempotency_key, out)
      return out
    } catch {
      throw uncertain()
    }
  }

  async function bid(
    r: BidRuntime,
    i: SubmitBidInput,
    t: { go: Go; can(): boolean },
  ): Promise<SubmitBidOutput> {
    const page = r.page()
    const id = i.order_id
    const opened = await openOrder(page, t.go, id)
    if (!opened.ok) throw fail('RATE_LIMITED', 'Страница заказа не открылась, отклик не нажат')
    await keepFormMap(r, page)
    const s: OrderScreen | null = opened.screen
    if (!s) {
      if (await closedNotice(page)) throw fail('ORDER_CLOSED', 'Заказ больше не принимает отклики')
      throw fail('LAYOUT_CHANGED', 'Страница заказа не дала свой ответ, отклик не нажат')
    }
    // Before any money only the wallet the page itself shows counts, never one remembered.
    const wallet = await walletOnPage(r, page)
    if (s.hasBid === true) {
      await markOrderBid(o.db, i.account_id, id)
      return { found_on_page: true, spent_rub: 0, balance_after_rub: wallet ?? r.eyes.balance() }
    }
    if (s.hasBid === null)
      throw fail('LAYOUT_CHANGED', 'Ответ страницы не говорит, был ли отклик, отклик не нажат')
    if (!s.open) throw fail('ORDER_CLOSED', 'Заказ больше не принимает отклики')
    const price = i.price_rub ?? null
    if (s.priceRequired && price === null)
      throw fail('INTERNAL', 'Профи.ру требует «Стоимость услуги», а цены в отклике нет')
    if (s.feeRub === null || wallet === null)
      throw fail('LAYOUT_CHANGED', 'Не прочитал цену отклика или кошелёк, отклик не нажат')
    if (wallet < s.feeRub)
      throw fail('NO_MONEY', `В кошельке ${wallet} ₽, а отклик стоит ${s.feeRub} ₽`)
    if (s.payment === 'other')
      throw fail('UNSAFE_PAYMENT', 'Профи.ру просит оплату не с кошелька, отклик не нажат')

    if (!(await openForm(page, { words: s.openerText, feeRub: s.feeRub })).open)
      throw fail('LAYOUT_CHANGED', 'Форма отклика не открылась')
    const pay = await readPayment(page, wallet)
    const due = pay.dueRub ?? s.feeRub
    if (wallet < due) throw fail('NO_MONEY', `В кошельке ${wallet} ₽, а к оплате ${due} ₽`)
    if (pay.way === 'other')
      throw fail('UNSAFE_PAYMENT', 'Профи.ру просит оплату не с кошелька, отклик не нажат')
    const filled = await fillForm(page, { priceRub: price, text: i.text })
    if (filled === 'no_field') throw fail('LAYOUT_CHANGED', 'Поля формы отклика не нашлись')
    if (filled === 'not_taken')
      throw fail('INTERNAL', 'Форма не приняла цену или текст целиком, отклик не нажат')
    if (!t.can())
      throw fail('RATE_LIMITED', 'Вкладка аккаунта перестала ходить на сайт, отклик не нажат')
    if (
      !(await savePress(o.db, {
        key: i.idempotency_key,
        accountId: i.account_id,
        orderId: id,
        dueRub: due,
      }))
    )
      return confirm(r, i, due, t)

    // From here the bid may be on the site: anything not confirmed is UNCERTAIN, never a failure.
    try {
      const clicked = await clickSubmit(page, s.submitText)
      if (clicked === 'no_button') {
        // Nothing was pressed after all: the written press goes, so a retry may try again.
        await o.db.delete(bidAttempt).where(eq(bidAttempt.idempotencyKey, i.idempotency_key))
        throw fail('LAYOUT_CHANGED', 'Кнопки отправки отклика нет')
      }
      if (clicked === 'unsure' || !(await waitFormClosed(page, closeMs))) throw uncertain()
    } catch (e) {
      if (e instanceof ProfiToolError) throw e
      throw uncertain()
    }
    return confirm(r, i, due, t)
  }

  return {
    async getOrder({ account_id, order_id }): Promise<GetOrderOutput> {
      const r = runtime(account_id)
      requireAlive(r.watch)
      const read = await r.inTab(async ({ go, can, later }) => {
        if (!can()) return null
        const page = r.page()
        const opened = await openOrder(page, go, order_id, true)
        if (!opened.ok) return null
        const known = await storedOrder(o.db, account_id, order_id).then(
          (x) => x,
          () => null,
        )
        // Closed only on the site's own word: a disabled bid block in the order answer, or, when the page gave no
        // answer, a notice on the page. A missing form can be a changed layout or a bid already made.
        const closed = opened.screen ? opened.screen.disabled : await closedNotice(page)
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
      })
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
      }
    },

    async submitBid(i) {
      if (!verifyPermit(o.permitSecret, i.idempotency_key, i.permit))
        throw fail('INTERNAL', 'Разрешение ядра не подходит к ключу отклика')
      const r = runtime(i.account_id)
      const known = await findBidAttempt(o.db, i.idempotency_key)
      if (known?.result) return known.result as SubmitBidOutput
      if (known) {
        const due = known.dueRub
        return r.inTab((t) => confirm(r, i, due, t)).catch(() => Promise.reject(uncertain()))
      }
      requireAlive(r.watch)
      return r.inTab(async (t) => {
        // A twin of this call may have pressed while this one waited for the tab.
        const twin = await findBidAttempt(o.db, i.idempotency_key)
        if (twin?.result) return twin.result as SubmitBidOutput
        if (twin) return confirm(r, i, twin.dueRub, t)
        requireAlive(r.watch)
        if (!t.can())
          throw fail(
            'RATE_LIMITED',
            'Вкладка аккаунта сейчас не ходит на сайт (живой экран, связь или IP), отклик не нажат',
          )
        try {
          return await bid(r, i, t)
        } catch (e) {
          if (e instanceof ProfiToolError) throw e
          // A failure of our own before the press (the database, the browser): nothing was pressed.
          const why = e instanceof Error ? e.message.slice(0, 120) : String(e)
          throw fail('INTERNAL', `Сбой до нажатия, отклик не нажат: ${why}`)
        }
      })
    },
  }
}
