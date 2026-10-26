/** What the order page's own answer says about bidding on it now. */
export type OrderScreen = {
  orderId: string
  /** A bid can be made: the page has a bid form and no disabled bid block. */
  open: boolean
  /** The page carries a disabled bid block: the site's own word that the order takes no bids. A missing form is not. */
  disabled: boolean
  /**
   * The answer carries no form, no bid forms, no tariff and no price, and no bid of ours: the shape of an order the
   * client closed, read live (order 95385373). A form without a tariff is a changed layout, not this.
   */
  bare: boolean
  /** What a bid costs this account now (with a discount it is «1»); null when the answer has no price. */
  feeRub: number | null
  /** This account already bid on the order. */
  hasBid: boolean | null
  /** The send button's words, from the answer itself. */
  submitText: string | null
  /** The words of what opens the bid form on the October page (tariffsBlock.scrollButtonText, «Написать клиенту»). */
  openerText: string | null
  /** The site will not take a bid without «Стоимость услуги». */
  priceRequired: boolean
  /** A payment way the form asks for: null when it shows none (the wallet pays), 'other' for anything else. */
  payment: 'wallet' | 'other' | null
}

type Button = { text?: unknown } | null | undefined
type Element = { name?: unknown; required?: unknown }
type Screen = {
  id?: unknown
  hasBid?: unknown
  price?: { value?: unknown } | null
  disabledBidBlock?: unknown
  tariffsBlock?: { scrollButtonText?: unknown } | null
  form?: {
    buttons?: { submit?: Button } | null
    elements?: { paymentMethod?: unknown } | null
  } | null
  bidForms?:
    | {
        bidSlideData?: {
          buttons?: { submit?: Button } | null
          elements?: Element[] | null
          paymentInfo?: { value?: unknown } | null
        } | null
      }[]
    | null
}

const rub = (v: unknown) => {
  const digits = String(v ?? '').replace(/[^\d]/g, '')
  return digits === '' ? null : Number(digits)
}
const text = (b: Button) => (typeof b?.text === 'string' && b.text.trim() ? b.text.trim() : null)

/** The order page's GraphQL answer (orders[].boOrderScreen, recorded live 24.10.2026) for one order. */
export function orderScreenFromAnswer(
  url: string,
  body: unknown,
  orderId: string,
): OrderScreen | null {
  if (!/\/graphql/.test(url)) return null
  const orders = (body as { data?: { orders?: unknown } } | null)?.data?.orders
  if (!Array.isArray(orders)) return null
  const o = (orders as ({ _id?: unknown; boOrderScreen?: Screen | null } | null)[]).find(
    (x) => String(x?._id ?? x?.boOrderScreen?.id ?? '') === orderId,
  )
  const s = o?.boOrderScreen
  if (!s) return null
  const slide = s.bidForms?.find((f) => f?.bidSlideData)?.bidSlideData ?? null
  const way = s.form?.elements?.paymentMethod
  return {
    orderId,
    open: !s.disabledBidBlock && (!!s.form || !!slide),
    disabled: !!s.disabledBidBlock,
    bare:
      !s.form &&
      (s.bidForms ?? []).length === 0 &&
      !s.tariffsBlock &&
      !s.price &&
      s.hasBid !== true,
    feeRub: rub(s.price?.value) ?? rub(slide?.paymentInfo?.value),
    hasBid: typeof s.hasBid === 'boolean' ? s.hasBid : null,
    submitText: text(s.form?.buttons?.submit) ?? text(slide?.buttons?.submit),
    openerText: text({ text: s.tariffsBlock?.scrollButtonText }),
    priceRequired: (slide?.elements ?? []).some((e) => e?.name === 'stavka' && e.required === true),
    payment: way === null || way === undefined ? null : paymentWay(JSON.stringify(way)),
  }
}

/**
 * Only the wallet is safe: a bank needs a confirmation the node cannot give (old Sara, П-58). Words that name a
 * bank anywhere, or no wallet at all, are «other».
 */
export function paymentWay(words: string): 'wallet' | 'other' {
  if (/СБП|Сбер|Sber|карт|T-?Pay|Т-?Pay|банк|ЮMoney|Мир/i.test(words)) return 'other'
  return /Кошел[её]к/i.test(words) ? 'wallet' : 'other'
}
