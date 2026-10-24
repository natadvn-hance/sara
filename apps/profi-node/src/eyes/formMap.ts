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
  /** Inside the bid form; a button outside it is kept only when its words are a bid's. */
  inForm: boolean
  visible: boolean
  disabled: boolean
}
export type PaymentLine = { text: string; testid: string | null; visible: boolean }
/** Something to press that is no button: a link, a card with a pointer, an element with a role. */
export type Clickable = {
  tag: string
  text: string
  testid: string | null
  role: string | null
  /** In the site's tariff block, where the October page opens its bid form. */
  inTariffs: boolean
  visible: boolean
}

/** What the bid form of an order page is made of, for calibrating the bid (M2 design 5.B). */
export type FormMap = {
  what: 'bid_form'
  fields: FormField[]
  buttons: FormButton[]
  payment: PaymentLine[]
  testids: string[]
  clickables: Clickable[]
}

/**
 * Maps the bid form of the open page without touching it: no click, no value of any field, no text a client wrote.
 * The bid form is the block around its text field (or a form, or a bid test id); the site's own words in it are kept.
 * Outside it a button or a payment line is kept only in a known shape, so a client's name or sentence never is.
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
      const textOf = (el: Element) => (el as HTMLElement).innerText ?? el.textContent ?? ''

      // The bid block: up from the text field to the first box with a button, never a box as long as an order.
      const blocks = [...document.querySelectorAll('form, [data-testid*="bid" i]')]
      for (const f of document.querySelectorAll(
        'textarea, [name="stavka"], [name="comments4client"]',
      )) {
        let box: Element | null = null
        for (let up = f.parentElement; up && up !== document.body; up = up.parentElement) {
          if (textOf(up).length > 2000) break
          box = up
          if (up.querySelector('button, [role="button"], input[type="submit"]')) break
        }
        if (box) blocks.push(box)
      }
      const inForm = (el: Element) => blocks.some((b) => b.contains(el))
      const BALANCE = '[aria-label="Баланс"]'

      // A label's own words: the field inside it (and what was typed there) is left out.
      const labelOf = (el: Element) => {
        const l = (el as HTMLInputElement).labels?.[0]
        if (!l) return null
        const c = l.cloneNode(true) as HTMLElement
        for (const x of c.querySelectorAll('input, textarea, select, option')) x.remove()
        return clip(c.textContent, 80)
      }
      const nearOf = (el: Element) => {
        if (!inForm(el)) return null
        const t = clip(textOf(el.previousElementSibling ?? document.createElement('i')), 60)
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

      // Buttons a bid may need, wherever they are: the rest outside the form may carry a client's name.
      // «Написать клиенту» is what the live order answer names its form opener (tariffsBlock.scrollButtonText).
      const BUTTON =
        /^(Продолжить|Откликнуться|Написать клиенту|Отправить|Оплатить|Пополнить|Подтвердить|Предложить|Отклик)/i
      const buttons = [
        ...document.querySelectorAll(
          'button, [role="button"], input[type="submit"], input[type="button"]',
        ),
      ]
        .map((el) => {
          const own = inForm(el)
          const text =
            clip(el.tagName === 'INPUT' ? (el as HTMLInputElement).value : textOf(el), 60) ?? ''
          return {
            text,
            testid: attr(el, 'data-testid'),
            aria: own ? attr(el, 'aria-label') : null,
            inForm: own,
            visible: shown(el),
            disabled:
              (el as HTMLButtonElement).disabled === true ||
              el.getAttribute('aria-disabled') === 'true',
          }
        })
        .filter((b) => (b.inForm ? b.text !== '' || b.testid !== null : BUTTON.test(b.text)))
        .slice(0, 60)

      // Outermost things with a pointer, a link or a role (the pointer passes down to the children).
      const TARIFFS = '[data-testid*="tariff" i]'
      const pointer = (el: Element | null) => !!el && getComputedStyle(el).cursor === 'pointer'
      const clickables = [
        ...document.querySelectorAll(
          'a, [role="link"], [role="tab"], [role="radio"], [role="option"], [tabindex], [onclick], div, span, li, label',
        ),
      ]
        .filter(
          (el) =>
            !el.closest('button, [role="button"]') &&
            (el.tagName === 'A' ||
              el.hasAttribute('role') ||
              el.hasAttribute('tabindex') ||
              el.hasAttribute('onclick') ||
              pointer(el)) &&
            !pointer(el.parentElement),
        )
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: clip(textOf(el), 60) ?? '',
          testid: attr(el, 'data-testid'),
          role: attr(el, 'role'),
          inTariffs: !!el.closest(TARIFFS),
          visible: shown(el),
        }))
        // Outside the form and the tariffs only a bid's words: a link or a card may carry a client's name.
        .filter((c) => c.inTariffs || BUTTON.test(c.text))
        .slice(0, 40)

      const payment: { text: string; testid: string | null; visible: boolean }[] = []
      const seen = new Set<string>()
      // Once per block: the footer's amount stays beside the same amount of the tariff block.
      const keep = (el: Element, text: string) => {
        const holder = el.closest('[data-testid]')
        const testid = holder ? attr(holder, 'data-testid') : null
        const key = `${testid} ${text}`
        if (seen.has(key) || payment.length >= 30) return
        seen.add(key)
        payment.push({ text, testid, visible: shown(el) })
      }
      // A short line of a known payment shape; a bare amount only in the form or the wallet of the top bar.
      const SHAPE =
        /^(К оплате|Цена отклика|Способ оплаты|Баланс|Пополнить|Отклик\s*•|Кошел[её]к(\s*[:·•]?\s*\d[\d\s]*₽)?$|СБП$|Система быстрых платежей$|SberPay$|Сбер(банк)?$|T-Pay$|Банковская карта$)/
      const AMOUNT = /^\d[\d\s]*₽$/
      const fits = (el: Element, t: string) =>
        SHAPE.test(t) || (AMOUNT.test(t) && (inForm(el) || !!el.closest(BALANCE)))
      // The site's own payment blocks: the wallet in the top bar, the form footer, the payment ways.
      for (const box of document.querySelectorAll(
        `${BALANCE}, ${TARIFFS}, [class*="payment" i], [data-testid*="pay" i], [data-testid*="footer" i]`,
      )) {
        for (const line of textOf(box).split('\n').slice(0, 10)) {
          const t = clip(line, 80)
          // The form and the tariff block are the site's own words.
          const own = inForm(box) || !!box.closest(TARIFFS)
          if (t && (own || (t.length <= 40 && fits(box, t)))) keep(box, t)
        }
      }
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length > 0) continue
        const t = clip(textOf(el), 41)
        if (t && t.length <= 40 && fits(el, t)) keep(el, t)
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

      return { what: 'bid_form' as const, fields, buttons, payment, testids, clickables }
    })
    .catch(() => null)
}
