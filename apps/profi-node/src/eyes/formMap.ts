import type { Page } from 'playwright'

export type FormField = {
  tag: 'input' | 'textarea' | 'select' | 'editable'
  type: string | null
  name: string | null
  testid: string | null
  aria: string | null
  label: string | null
  /** Short text right before the field, when it has no label of its own (a React form may draw labels as divs). */
  near: string | null
  placeholder: string | null
  required: boolean
  disabled: boolean
  visible: boolean
  maxLength: number | null
  options?: string[]
}
export type FormButton = {
  text: string
  testid: string | null
  aria: string | null
  visible: boolean
  disabled: boolean
}
export type PaymentLine = { text: string; testid: string | null; visible: boolean }

/** What the bid form of an order page is made of, for calibrating the bid (M2 design 5.B). */
export type FormMap = {
  what: 'bid_form'
  fields: FormField[]
  buttons: FormButton[]
  payment: PaymentLine[]
  testids: string[]
}

/**
 * Maps the bid form of the open page without touching it: no click, no value of any field, no text a client wrote.
 * Payment lines come from the site's own payment blocks, or are short lines of a known payment shape.
 */
export async function readFormMap(page: Page): Promise<FormMap | null> {
  return page
    .evaluate(() => {
      const clip = (s: string | null | undefined, n: number) => {
        const t = (s ?? '').replace(/\s+/g, ' ').trim()
        return t === '' ? null : t.slice(0, n)
      }
      const shown = (el: Element) =>
        el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        el.getBoundingClientRect().width > 0
      const attr = (el: Element, a: string) => clip(el.getAttribute(a), 80)
      // A label's own words: the field inside it (and what was typed there) is left out.
      const labelOf = (el: Element) => {
        const l = (el as HTMLInputElement).labels?.[0]
        if (!l) return null
        const c = l.cloneNode(true) as HTMLElement
        for (const x of c.querySelectorAll('input, textarea, select, option')) x.remove()
        return clip(c.textContent, 80)
      }
      const nearOf = (el: Element) => {
        const t = clip((el.previousElementSibling as HTMLElement | null)?.innerText, 60)
        return t && t.length <= 40 ? t : null
      }

      const fields = [
        ...document.querySelectorAll(
          'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
        ),
      ]
        .slice(0, 60)
        .map((el) => {
          const tag = el.tagName.toLowerCase()
          const f = el as HTMLInputElement
          const max = f.maxLength
          return {
            tag: (tag === 'input' || tag === 'textarea' || tag === 'select'
              ? tag
              : 'editable') as FormField['tag'],
            type: tag === 'input' ? f.type : attr(el, 'type'),
            name: attr(el, 'name'),
            testid: attr(el, 'data-testid'),
            aria: attr(el, 'aria-label'),
            label: labelOf(el),
            near: labelOf(el) ? null : nearOf(el),
            placeholder: attr(el, 'placeholder'),
            required: f.required === true || el.getAttribute('aria-required') === 'true',
            disabled: f.disabled === true || el.getAttribute('aria-disabled') === 'true',
            visible: shown(el),
            maxLength: typeof max === 'number' && max > 0 ? max : null,
            ...(tag === 'select' && {
              options: [...(el as HTMLSelectElement).options]
                .slice(0, 15)
                .map((o) => clip(o.text, 40) ?? ''),
            }),
          }
        })

      const buttons = [
        ...document.querySelectorAll(
          'button, [role="button"], input[type="submit"], input[type="button"]',
        ),
      ]
        .slice(0, 60)
        .map((el) => ({
          text:
            clip(
              el.tagName === 'INPUT'
                ? (el as HTMLInputElement).value
                : (el as HTMLElement).innerText,
              60,
            ) ?? '',
          testid: attr(el, 'data-testid'),
          aria: attr(el, 'aria-label'),
          visible: shown(el),
          disabled:
            (el as HTMLButtonElement).disabled === true ||
            el.getAttribute('aria-disabled') === 'true',
        }))
        .filter((b) => b.text !== '' || b.testid !== null || b.aria !== null)

      const payment: { text: string; testid: string | null; visible: boolean }[] = []
      const seen = new Set<string>()
      const keep = (el: Element, text: string) => {
        if (seen.has(text) || payment.length >= 30) return
        seen.add(text)
        const holder = el.closest('[data-testid]')
        payment.push({
          text,
          testid: holder ? attr(holder, 'data-testid') : null,
          visible: shown(el),
        })
      }
      // The site's own payment blocks: the wallet in the top bar, the form footer, the payment ways.
      for (const box of document.querySelectorAll(
        '[aria-label="Баланс"], [class*="payment" i], [data-testid*="pay" i], [data-testid*="footer" i]',
      )) {
        for (const line of ((box as HTMLElement).innerText ?? '').split('\n').slice(0, 10)) {
          const t = clip(line, 80)
          if (t) keep(box, t)
        }
      }
      // Anywhere else only a short line of a known payment shape, so a client's sentence never matches.
      const SHAPE =
        /^(К оплате|Цена отклика|Способ оплаты|Баланс|Пополнить|Отклик\s*•|Кошел[её]к(\s*[:·•]?\s*\d[\d\s ]*₽)?$|СБП$|Система быстрых платежей$|SberPay$|Сбер(банк)?$|T-Pay$|Банковская карта$|\d[\d\s ]*₽$)/
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length > 0) continue
        const t = clip((el as HTMLElement).innerText, 41)
        if (t && t.length <= 40 && SHAPE.test(t)) keep(el, t)
      }

      const testids = [
        ...new Set(
          [...document.querySelectorAll('[data-testid]')].map(
            (el) => el.getAttribute('data-testid') ?? '',
          ),
        ),
      ]
        .filter(Boolean)
        .slice(0, 200)

      return { what: 'bid_form' as const, fields, buttons, payment, testids }
    })
    .catch(() => null)
}
