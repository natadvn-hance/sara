import type { Locator, Page } from 'playwright'
import { paymentWay } from './screen'

// The October form as the order answer names it (boOrderScreen.form): «stavka» is «Стоимость услуги», «comments4client»
// the text. Placeholders are the fallback. Calibrated by the maps of src/eyes/formMap.ts.
const PRICE = '[name="stavka"], input[placeholder="Сумма"]'
const TEXT = '[name="comments4client"], textarea[placeholder^="Расскажите о своём опыте"]'
const CONTINUE = 'Продолжить'
const TARIFFS = '[data-testid*="tariff" i]'
// September anchors (old Sara, paymentPanel.js, checked live 19.09.2026).
const FOOTER = '[data-testid="bid_form_footer"]'
const WAY = '.payment-methods__name'

const shown = (page: Page, css: string) => page.locator(css).filter({ visible: true })
const rubIn = (text: string | null) => {
  const m = /(\d[\d\s ]*)\s*₽/.exec(text ?? '')
  return m?.[1] ? Number(m[1].replace(/[^\d]/g, '')) : null
}

/** What may open the form: the answer's opener words and the fee the opener shows beside «Продолжить». */
export type Opener = { words: string | null; feeRub: number | null }

// «Продолжить» with the fee beside it (the live opener: a div of two divs, so no space in its text).
const CONTINUE_PRICED = /^\s*Продолжить\s*\d[\d\s]*₽\s*$/

/**
 * The text field is on screen, after pressing what opens the form. On the live page (maps of 24.10.2026) that is no
 * button but a div in the tariff block: «Продолжить» with the fee beside it, pressed only when the fee is the order's
 * own. Then the answer's opener words (tariffsBlock.scrollButtonText), one in the tariff block or the only one on the
 * page, and the September button «Продолжить». Two of a kind, or another fee, presses nothing.
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
  } = {},
): Promise<{ open: boolean; pressed: boolean; by: string | null }> {
  const none = { open: false, pressed: false, by: null }
  const text = shown(page, TEXT)
  const tariffs = page.locator(TARIFFS)
  const priced = tariffs.locator('*').filter({ hasText: CONTINUE_PRICED }).filter({ visible: true })
  const byWords = (scope: Page | Locator) =>
    opener.words ? scope.getByText(opener.words, { exact: true }).filter({ visible: true }) : null
  const september =
    o.september === false
      ? null
      : page.getByRole('button', { name: CONTINUE, exact: true }).filter({ visible: true })
  const anyOpener = [priced, byWords(page), september].reduce<Locator | null>(
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
    if (!seen.one || opener.feeRub === null || fee !== opener.feeRub) return none
    press = priced.last()
    by = `${CONTINUE} ${fee} ₽`
  } else {
    for (const [c, words] of [
      [byWords(tariffs), opener.words],
      [byWords(page), opener.words],
      [september, CONTINUE],
    ] as const) {
      if (c && (await c.count()) === 1) {
        press = c
        by = words
        break
      }
    }
  }
  if (!press) return none
  // Never what sends a form: an opener is no submit and lives outside the form.
  const sends = await press
    .evaluate((el) => !!el.closest('form, button[type="submit"], input[type="submit"]'))
    .catch(() => true)
  if (sends || (o.may && !o.may())) return none
  await press.click({ timeout: 5000 }).catch(() => {})
  const open = await text
    .first()
    .waitFor({ timeout: ms })
    .then(() => true)
    .catch(() => false)
  return { open, pressed: true, by }
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
  // «К оплате: N ₽» on one line, or «К оплате:» and the amount on the next.
  const at = lines.findIndex((l) => /^К оплате/.test(l))
  const dueAt = at < 0 ? -1 : rubIn(lines[at] ?? '') !== null ? at : at + 1
  const dueRub = dueAt < 0 ? null : rubIn(lines[dueAt] ?? '')
  const rest = lines.filter((l, i) => i !== at && i !== dueAt && !PRESS.test(l))
  const wayText = (await read(WAY))?.trim() || rest.join(' ') || null
  const wallet =
    !!wayText &&
    (WALLET.test(wayText) ||
      (AMOUNT.test(wayText) && walletRub !== null && rubIn(wayText) === walletRub))
  return { dueRub, way: wallet ? 'wallet' : 'other', wayText }
}

/**
 * Fills the price (empty for null) and the text, then reads them back: what the form did not take whole stops. The
 * live form (25.10.2026) has a range «От» «До» without names: the price goes to «От», «До» stays empty. A single
 * «stavka» field («Сумма») is taken too.
 */
export async function fillForm(
  page: Page,
  v: { priceRub: number | null; text: string },
): Promise<'ok' | 'no_field' | 'not_taken'> {
  const text = shown(page, TEXT)
  if ((await text.count()) !== 1) return 'no_field'
  const block = formBlock(page)
  const single = shown(page, PRICE)
  const from = block.getByLabel('От', { exact: true }).filter({ visible: true })
  const price = (await single.count()) === 1 ? single : (await from.count()) === 1 ? from : null
  if (!price && v.priceRub !== null) return 'no_field'
  const want = v.priceRub === null ? '' : String(v.priceRub)
  try {
    if (price) await price.fill(want, { timeout: 5000 })
    await text.fill(v.text, { timeout: 5000 })
    const gotText = await text.inputValue()
    const gotPrice = price ? (await price.inputValue()).replace(/[^\d]/g, '') : ''
    // A textarea keeps line breaks as \n whatever was typed.
    return gotText === v.text.replace(/\r\n?/g, '\n') && gotPrice === want ? 'ok' : 'not_taken'
  } catch {
    return 'no_field'
  }
}

/**
 * Presses the send button of the form that holds the text field. A trial press first: a button that cannot be
 * pressed is 'no_button' and nothing happened; a failure of the press itself is 'unsure'.
 */
export async function clickSubmit(
  page: Page,
  words: string | null,
): Promise<'clicked' | 'no_button' | 'unsure'> {
  const name = words ?? 'Откликнуться'
  const byName = (scope: Page | ReturnType<Page['locator']>) =>
    scope.getByRole('button', { name, exact: true }).filter({ visible: true })
  let button = byName(formBlock(page))
  if ((await button.count()) !== 1) {
    button = byName(page)
    if ((await button.count()) !== 1) return 'no_button'
  }
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

/** The form closed: its text field left the screen within ms (old Sara's one sign of a bid taken). */
export async function waitFormClosed(page: Page, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if ((await shown(page, TEXT).count()) === 0) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
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
