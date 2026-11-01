import { priceUpTo } from '@sara/shared'
import type { Locator, Page } from 'playwright'

// The October form as the order answer names it (boOrderScreen.form): «stavka» is «Стоимость услуги», «comments4client»
// the text. Placeholders are the fallback. Calibrated by the maps of src/eyes/formMap.ts.
const PRICE = '[name="stavka"], input[placeholder="Сумма"]'
const TEXT = '[name="comments4client"], textarea[placeholder^="Расскажите о своём опыте"]'
const CONTINUE = 'Продолжить'
const TARIFFS = '[data-testid*="tariff" i]'
// The footer of the open form, holding the amount, the payment way and the send button (old Sara, paymentPanel.js,
// 19.09.2026; the live map of 25.10.2026).
const FOOTER = '[data-testid="bid_form_footer"]'
const PAY = '[data-testid="payment_methods_form_pay_button"]'

const shown = (page: Page, css: string) => page.locator(css).filter({ visible: true })
const rubIn = (text: string | null) => {
  const m = /(\d[\d\s ]*)\s*₽/.exec(text ?? '')
  return m?.[1] ? Number(m[1].replace(/[^\d]/g, '')) : null
}

/** What may open the form: the answer's opener words and the fee the opener shows beside «Продолжить». */
export type Opener = { words: string | null; feeRub: number | null }

/** Why the form did not open, for the node's log and the record of a refused bid. */
export type OpenerMiss =
  | 'no_opener'
  | 'opener_fee'
  | 'two_openers'
  | 'opener_sends'
  | 'may_not'
  | 'no_field'

// «Продолжить» with the fee beside it (the live opener: a div of two divs, so no space in its text).
const CONTINUE_PRICED = /^\s*Продолжить\s*\d[\d\s]*₽\s*$/
// The order card's button of the page without a tariff block (live 31.10.2026, order 95590077: «Цена отклика» and
// this one button, no field until it is pressed).
const CARD_OPENER = 'Откликнуться'

/**
 * The text field is on screen, after pressing what opens the form. On the live page (maps of 24.10.2026) that is no
 * button but a div in the tariff block: «Продолжить» with the fee beside it, pressed only when the fee is the order's
 * own. Then the answer's opener words (tariffsBlock.scrollButtonText), one in the tariff block or the only one on the
 * page, the September button «Продолжить», and for a bid the order card's «Откликнуться» of a page with no tariff
 * block. Two of a kind, or another fee, presses nothing.
 */
export async function openForm(
  page: Page,
  opener: Opener,
  ms = 10000,
  o: {
    /** Asked right before the press: the tab may have stopped being ours meanwhile. */
    may?: () => boolean
    /** «Продолжить» as the September button; the node's own calibration never uses it. */
    september?: boolean
    /**
     * The order card's «Откликнуться», the last one tried and only when it is the one such button on the page, outside
     * any form. A bid takes it; the calibration never does, since its words are the send's too.
     */
    card?: boolean
  } = {},
): Promise<{
  open: boolean
  pressed: boolean
  by: string | null
  /** Why it did not open; null when it did. */
  why?: OpenerMiss | null
  /** The amount the «Продолжить» opener showed, when one was there. */
  shownRub?: number | null
}> {
  const none = (why: OpenerMiss, shownRub: number | null = null) => ({
    open: false,
    pressed: false,
    by: null,
    why,
    shownRub,
  })
  const text = shown(page, TEXT)
  const tariffs = page.locator(TARIFFS)
  const priced = tariffs.locator('*').filter({ hasText: CONTINUE_PRICED }).filter({ visible: true })
  const byWords = (scope: Page | Locator) =>
    opener.words ? scope.getByText(opener.words, { exact: true }).filter({ visible: true }) : null
  const september =
    o.september === false
      ? null
      : page.getByRole('button', { name: CONTINUE, exact: true }).filter({ visible: true })
  const card = o.card
    ? page.getByRole('button', { name: CARD_OPENER, exact: true }).filter({ visible: true })
    : null
  const anyOpener = [priced, byWords(page), september, card].reduce<Locator | null>(
    (a, b) => (a && b ? a.or(b) : (a ?? b)),
    null,
  )
  await (anyOpener ? text.or(anyOpener) : text)
    .first()
    .waitFor({ timeout: ms })
    .catch(() => {})
  if ((await text.count()) > 0) return { open: true, pressed: false, by: null }

  let press: Locator | null = null
  let by: string | null = null
  // A wrapper holding only the opener matches too: one chain of nested matches is one opener.
  const seen = await priced
    .evaluateAll((els) => {
      const last = els[els.length - 1]
      return {
        n: els.length,
        one: !!last && els.every((e) => e.contains(last)),
        text: last?.textContent ?? '',
      }
    })
    .catch(() => ({ n: 0, one: false, text: '' }))
  if (seen.n > 0) {
    const fee = Number(seen.text.replace(/[^\d]/g, ''))
    if (!seen.one) return none('two_openers', fee)
    if (opener.feeRub === null || fee !== opener.feeRub) return none('opener_fee', fee)
    press = priced.last()
    by = `${CONTINUE} ${fee} ₽`
  } else {
    for (const [c, words] of [
      [byWords(tariffs), opener.words],
      [byWords(page), opener.words],
      [september, CONTINUE],
      [card, CARD_OPENER],
    ] as const) {
      if (c && (await c.count()) === 1) {
        press = c
        by = words
        break
      }
    }
  }
  if (!press) return none('no_opener')
  // Never what sends a form: an opener is no submit and lives outside the form.
  const sends = await press
    .evaluate((el) => !!el.closest('form, button[type="submit"], input[type="submit"]'))
    .catch(() => true)
  if (sends) return none('opener_sends')
  if (o.may && !o.may()) return none('may_not')
  await press.click({ timeout: 5000 }).catch(() => {})
  const open = await text
    .first()
    .waitFor({ timeout: ms })
    .then(() => true)
    .catch(() => false)
  return { open, pressed: true, by, why: open ? null : 'no_field', shownRub: null }
}

// The block of the open form: the one that holds the text field (live: bid_window_container).
const formBlock = (page: Page) =>
  page
    .locator('form, [data-testid*="bid" i]')
    .filter({ has: shown(page, TEXT) })
    .last()

const AMOUNT = /^\d[\d\s]*₽$/
// The wallet, named so in the footer, with or without its amount; any other words are another way to pay.
const WALLET = /^(Кошел[её]к|С кошелька|Из кошелька)(\s*[:·•]?\s*\d[\d\s]*₽)?$/i
const PRESS = /^(Откликнуться|Оплатить|Отправить|Продолжить)$/i

/**
 * The footer of the open form (live 25.10.2026: «К оплате:», the amount, the payment way, «Откликнуться»): the amount
 * due and the payment way. Only a way the footer names as the wallet, or labels by the wallet's own amount (old Sara,
 * orders 94430827 and 94476795), is the wallet; a way not shown or not known is 'other', so nothing is paid by it.
 */
export async function readPayment(
  page: Page,
  walletRub: number | null,
): Promise<{ dueRub: number | null; way: 'wallet' | 'other'; wayText: string | null }> {
  // The form is on screen already: what is not there now is not waited for.
  const read = async (css: string) => {
    const el = shown(page, css)
    if ((await el.count()) === 0) return null
    return el
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => null)
  }
  const footer =
    (await read(FOOTER)) ??
    (await page
      .getByText(/К оплате/)
      .filter({ visible: true })
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => null))
  const lines = (footer ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  // «К оплате: N ₽» on one line, or «К оплате:» and the amount alone on the next.
  const at = lines.findIndex((l) => /^К оплате/.test(l))
  const dueAt =
    at < 0
      ? -1
      : rubIn(lines[at] ?? '') !== null
        ? at
        : AMOUNT.test(lines[at + 1] ?? '')
          ? at + 1
          : -1
  const dueRub = dueAt < 0 ? null : rubIn(lines[dueAt] ?? '')
  // Every other word of the footer is the way: a picker with the wallet among others is not the wallet.
  const rest = lines.filter((l, i) => i !== at && i !== dueAt && !PRESS.test(l))
  const wayText = rest.join(' ') || null
  // Live 27.10.2026 (orders 95468549, 95469521, wallet 5049 ₽): with money enough the footer names no way at all,
  // only «К оплате: N ₽» and the button, and the wallet pays. A footer with no way is the wallet only when the amount
  // due is read and the wallet covers it; with too little money Profi.ru shows a bank way (СБП) instead.
  const silentWallet =
    wayText === null && dueRub !== null && walletRub !== null && walletRub >= dueRub
  const wallet =
    silentWallet ||
    (!!wayText &&
      (WALLET.test(wayText) ||
        (AMOUNT.test(wayText) && walletRub !== null && rubIn(wayText) === walletRub)))
  return { dueRub, way: wallet ? 'wallet' : 'other', wayText }
}

/**
 * Fills the price (empty for null) and the text, then reads them back: what the form did not take whole stops. The
 * live form (25.10.2026) has a range «От» «До» without names: the price goes to «От», and «До» gets the top of the
 * range (`priceUpTo`, Boris 27.10.2026), or stays empty when there is no price. A single
 * «stavka» field («Сумма») is taken too.
 */
export async function fillForm(
  page: Page,
  v: { priceRub: number | null; text: string },
): Promise<'ok' | 'no_field' | 'not_taken'> {
  const text = shown(page, TEXT)
  if ((await text.count()) !== 1) return 'no_field'
  // Only fields of the form itself: a top-up «Сумма» elsewhere on the page is never filled.
  const block = formBlock(page)
  const single = block.locator(PRICE).filter({ visible: true })
  const from = block.getByLabel('От', { exact: true }).filter({ visible: true })
  const to = block.getByLabel('До', { exact: true }).filter({ visible: true })
  const range = (await single.count()) !== 1 && (await from.count()) === 1
  const price = range ? from : (await single.count()) === 1 ? single : null
  if (!price && v.priceRub !== null) return 'no_field'
  const want = v.priceRub === null ? '' : String(v.priceRub)
  // «До» is the top of the range Sara gives, never what the page filled itself.
  const wantTo = v.priceRub === null ? '' : String(priceUpTo(v.priceRub))
  try {
    if (price) await price.fill(want, { timeout: 5000 })
    const hasTo = range && (await to.count()) === 1
    if (hasTo) await to.fill(wantTo, { timeout: 5000 })
    await text.fill(v.text, { timeout: 5000 })
    const gotText = await text.inputValue()
    const gotPrice = price ? (await price.inputValue()).replace(/[^\d]/g, '') : ''
    const gotTo = hasTo ? await to.inputValue() : ''
    // A textarea keeps line breaks as \n whatever was typed.
    return gotText === v.text.replace(/\r\n?/g, '\n') &&
      gotPrice === want &&
      gotTo.replace(/[^\d]/g, '') === (hasTo ? wantTo : '')
      ? 'ok'
      : 'not_taken'
  } catch {
    return 'no_field'
  }
}

/**
 * Presses the send button of the form that holds the text field: its pay button (live: payment_methods_form_pay_button),
 * or the one button with the send words in it; never a button outside the form. A trial press first: a button that
 * cannot be pressed is 'no_button' and nothing happened; a failure of the press itself is 'unsure'.
 */
export async function clickSubmit(
  page: Page,
  words: string | null,
): Promise<'clicked' | 'no_button' | 'unsure'> {
  const name = words ?? 'Откликнуться'
  const byName = (scope: Page | ReturnType<Page['locator']>) =>
    scope.getByRole('button', { name, exact: true }).filter({ visible: true })
  const block = formBlock(page)
  const pay = block.locator(PAY).filter({ visible: true })
  const button = (await pay.count()) === 1 ? pay : byName(block)
  if ((await button.count()) !== 1) return 'no_button'
  try {
    await button.click({ trial: true, timeout: 5000 })
  } catch {
    return 'no_button'
  }
  try {
    await button.click({ timeout: 5000 })
    return 'clicked'
  } catch {
    return 'unsure'
  }
}

/** The bid form's text field is on screen. */
export async function formOnScreen(page: Page): Promise<boolean> {
  return (await shown(page, TEXT).count()) > 0
}

// Notices of orders that take no more bids, seen live (old Sara, orderAvailability.js, 29.09.2026).
const CLOSED = [
  /Заказ скрыт|не готов получать новые отклики/,
  /уже наш[её]л специалиста/,
  /[Зз]аказ закрыт/,
  /[Зз]аказ отмен[её]н/,
]

/** The page says the order takes no more bids. */
export async function closedNotice(page: Page): Promise<boolean> {
  const body = await page
    .locator('body')
    .innerText({ timeout: 2000 })
    .catch(() => '')
  return CLOSED.some((re) => re.test(body))
}
