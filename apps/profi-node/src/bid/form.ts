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

/**
 * The text field is on screen, after pressing what opens the form. On the live page (24.10.2026) that is no button:
 * its words come from the order answer (tariffsBlock.scrollButtonText, «Написать клиенту»); one in the tariff
 * block, or the only one on the page, is pressed. «Продолжить» was the September opener.
 */
export async function openForm(page: Page, opener: string | null, ms = 10000): Promise<boolean> {
  const text = shown(page, TEXT)
  const byWords = (scope: Page | Locator) =>
    opener ? scope.getByText(opener, { exact: true }).filter({ visible: true }) : null
  const september = page
    .getByRole('button', { name: CONTINUE, exact: true })
    .filter({ visible: true })
  const anyOpener = byWords(page)?.or(september) ?? september
  await text
    .or(anyOpener)
    .first()
    .waitFor({ timeout: ms })
    .catch(() => {})
  if ((await text.count()) > 0) return true
  const inTariffs = byWords(page.locator(TARIFFS))
  const candidates = [inTariffs, byWords(page), september]
  let press: Locator | null = null
  for (const c of candidates) {
    if (c && (await c.count()) === 1) {
      press = c
      break
    }
  }
  if (!press) return false
  await press.click({ timeout: 5000 }).catch(() => {})
  return text
    .first()
    .waitFor({ timeout: ms })
    .then(() => true)
    .catch(() => false)
}

/**
 * The payment block of the open form: the amount due and the payment way. A way labelled by the wallet's own
 * amount is the wallet (old Sara, orders 94430827 and 94476795); no way shown is null.
 */
export async function readPayment(
  page: Page,
  walletRub: number | null,
): Promise<{ dueRub: number | null; way: 'wallet' | 'other' | null }> {
  const read = (css: string) =>
    shown(page, css)
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => null)
  const footer =
    (await read(FOOTER)) ??
    (await page
      .getByText(/К оплате/)
      .filter({ visible: true })
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => null))
  const wayText = (await read(WAY))?.trim() ?? null
  if (!wayText) return { dueRub: rubIn(footer), way: null }
  const byAmount = /^\d[\d\s ]*₽$/.test(wayText) && rubIn(wayText) === walletRub
  return { dueRub: rubIn(footer), way: byAmount ? 'wallet' : paymentWay(wayText) }
}

/** Fills the price (empty for null) and the text, then reads them back: what the form did not take whole stops. */
export async function fillForm(
  page: Page,
  v: { priceRub: number | null; text: string },
): Promise<'ok' | 'no_field' | 'not_taken'> {
  const text = shown(page, TEXT)
  const price = shown(page, PRICE)
  if ((await text.count()) !== 1) return 'no_field'
  const hasPrice = (await price.count()) === 1
  if (!hasPrice && v.priceRub !== null) return 'no_field'
  const want = v.priceRub === null ? '' : String(v.priceRub)
  try {
    if (hasPrice) await price.fill(want, { timeout: 5000 })
    await text.fill(v.text, { timeout: 5000 })
    const gotText = await text.inputValue()
    const gotPrice = hasPrice ? (await price.inputValue()).replace(/[^\d]/g, '') : ''
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
  const form = page
    .locator('form, [data-testid*="bid" i]')
    .filter({ has: shown(page, TEXT) })
    .last()
  let button = byName(form)
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
