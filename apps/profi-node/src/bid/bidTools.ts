import type { GetOrderOutput, SubmitBidInput, SubmitBidOutput } from '@sara/shared'
import { verifyPermit } from '@sara/shared/permit'
import type { Page } from 'playwright'
import type { NodeDb } from '../db/client'
import type { Eyes } from '../eyes/eyes'
import { readFormMap } from '../eyes/formMap'
import type { Insurance } from '../eyes/insurance'
import type { Parsers } from '../eyes/parsers'
import { profiParsers } from '../eyes/profiParsers'
import { ProfiToolError, type ProfiToolsImpl } from '../mcp/server'
import { markOrderBid } from '../store/raw'
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
}

type Go = (path: string) => Promise<boolean>
const fail = (c: ConstructorParameters<typeof ProfiToolError>[0], m: string) =>
  new ProfiToolError(c, m)

/**
 * profi.get_order and profi.submit_bid on the site itself (FR-LEAD-5, FR-LEAD-8, NFR-REL-4, M2 design 5.B). The order
 * page is opened in the account tab only when it may move; its own answer says whether the order is open, what a bid
 * costs and whether this account already bid. A bid counts only when the form closed and a fresh read of that
 * answer shows it.
 */
export function createBidTools(o: {
  db: NodeDb
  permitSecret: string
  parsers: Parsers
  accounts: Map<string, BidRuntime>
  answerMs?: number
  closeMs?: number
}): Pick<ProfiToolsImpl, 'getOrder' | 'submitBid'> {
  const answerMs = o.answerMs ?? 20000
  const closeMs = o.closeMs ?? 15000
  const orderPath = o.parsers.paths.order ?? profiParsers.paths.order ?? ((id) => id)
  // Answers by idempotency key: a call repeated after a lost answer clicks nothing. Bounded, oldest out first.
  const done = new Map<string, SubmitBidOutput>()
  // Clicked but not confirmed: if the retry finds the bid on the page, it was this click and its money.
  const pressed = new Map<string, number>()
  const remember = <T>(m: Map<string, T>, key: string, v: T) => {
    if (m.size >= 500) m.delete(m.keys().next().value ?? '')
    m.set(key, v)
  }

  const runtime = (id: string) => {
    const r = o.accounts.get(id)
    if (!r) throw fail('NOT_FOUND', `account ${id} is not served here`)
    return r
  }

  /** Opens the order page and waits for its own answer about this order (null when none came). */
  async function openOrder(page: Page, go: Go, orderId: string) {
    const answer = page
      .waitForResponse(
        async (res) =>
          orderScreenFromAnswer(res.url(), await res.json().catch(() => null), orderId) !== null,
        { timeout: answerMs },
      )
      .then(async (res) => orderScreenFromAnswer(res.url(), await res.json(), orderId))
      .catch(() => null)
    if (!(await go(orderPath(orderId)))) return { ok: false, screen: null }
    return { ok: true, screen: await answer }
  }

  /** The wallet in the top bar of the page now, told to the eyes too; what they knew when the bar is unreadable. */
  async function walletNow(r: BidRuntime, page: Page): Promise<number | null> {
    const signals = await o.parsers.fromHeaderDom(page).catch(() => [])
    await r.eyes.onParsed({ recognized: false, signals }, 'dom')
    const rub = signals.find((s) => s.t === 'balance')
    return rub && rub.t === 'balance' ? rub.rub : r.eyes.balance()
  }

  async function keepFormMap(r: BidRuntime, page: Page) {
    const body = await readFormMap(page)
    if (body)
      await r.eyes
        .onRaw({ kind: 'dom', url: page.url(), body, receivedAt: new Date().toISOString() })
        .catch(() => {})
  }

  async function bid(r: BidRuntime, i: SubmitBidInput, go: Go): Promise<SubmitBidOutput> {
    const page = r.page()
    const id = i.order_id
    const opened = await openOrder(page, go, id)
    if (!opened.ok) throw fail('RATE_LIMITED', 'Страница заказа не открылась, отклик не нажат')
    await keepFormMap(r, page)
    const s: OrderScreen | null = opened.screen
    if (!s) {
      if (await closedNotice(page)) throw fail('ORDER_CLOSED', 'Заказ больше не принимает отклики')
      throw fail('LAYOUT_CHANGED', 'Страница заказа не дала свой ответ, отклик не нажат')
    }
    const wallet = await walletNow(r, page)
    if (s.hasBid) {
      await markOrderBid(o.db, i.account_id, id)
      const spent = pressed.get(i.idempotency_key) ?? 0
      return { found_on_page: true, spent_rub: spent, balance_after_rub: wallet }
    }
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

    if (!(await openForm(page))) throw fail('LAYOUT_CHANGED', 'Форма отклика не открылась')
    const pay = await readPayment(page, wallet)
    const due = pay.dueRub ?? s.feeRub
    if (wallet < due) throw fail('NO_MONEY', `В кошельке ${wallet} ₽, а к оплате ${due} ₽`)
    if (pay.way === 'other')
      throw fail('UNSAFE_PAYMENT', 'Профи.ру просит оплату не с кошелька, отклик не нажат')
    const filled = await fillForm(page, { priceRub: price, text: i.text })
    if (filled === 'no_field') throw fail('LAYOUT_CHANGED', 'Поля формы отклика не нашлись')
    if (filled === 'not_taken')
      throw fail('INTERNAL', 'Форма не приняла цену или текст целиком, отклик не нажат')
    const clicked = await clickSubmit(page, s.submitText)
    if (clicked === 'no_button') throw fail('LAYOUT_CHANGED', 'Кнопки отправки отклика нет')

    // From here the bid may be on the site: anything not confirmed is UNCERTAIN, never a failure.
    remember(pressed, i.idempotency_key, due)
    const uncertain = fail('UNCERTAIN', 'Отклик нажат, но страница его не показала')
    if (clicked === 'unsure' || !(await waitFormClosed(page, closeMs))) throw uncertain
    const again = await openOrder(page, go, id)
    if (again.screen?.hasBid !== true) throw uncertain
    await markOrderBid(o.db, i.account_id, id)
    return { found_on_page: true, spent_rub: due, balance_after_rub: await walletNow(r, page) }
  }

  return {
    async getOrder({ account_id, order_id }): Promise<GetOrderOutput> {
      const r = runtime(account_id)
      requireAlive(r.watch)
      const screen = await r.inTab(async ({ go, can }) => {
        if (!can()) return null
        const page = r.page()
        const opened = await openOrder(page, go, order_id)
        if (!opened.ok) return null
        // An order the eyes never stored is read from its page now.
        const known = await storedOrder(o.db, account_id, order_id).then(
          () => true,
          () => false,
        )
        if (!known && o.parsers.fromOrderDom)
          await r.eyes.onParsed(await o.parsers.fromOrderDom(page, order_id), 'dom')
        if (opened.screen?.hasBid) await markOrderBid(o.db, account_id, order_id)
        return opened.screen
      })
      const stored = await storedOrder(o.db, account_id, order_id)
      if (!screen) return stored
      return {
        ...stored,
        open: screen.open,
        bid_price_rub: screen.feeRub ?? stored.bid_price_rub,
        has_bid: screen.hasBid ?? stored.has_bid,
      }
    },

    async submitBid(i) {
      if (!verifyPermit(o.permitSecret, i.idempotency_key, i.permit))
        throw fail('INTERNAL', 'Разрешение ядра не подходит к ключу отклика')
      const r = runtime(i.account_id)
      requireAlive(r.watch)
      const before = done.get(i.idempotency_key)
      if (before) return before
      return r.inTab(async ({ go, can }) => {
        // A twin of this call may have finished while this one waited for the tab.
        const twin = done.get(i.idempotency_key)
        if (twin) return twin
        requireAlive(r.watch)
        if (!can())
          throw fail(
            'RATE_LIMITED',
            'Вкладка аккаунта сейчас не ходит на сайт (живой экран, связь или IP), отклик не нажат',
          )
        const out = await bid(r, i, go)
        remember(done, i.idempotency_key, out)
        return out
      })
    },
  }
}
