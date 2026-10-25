import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { orderScreenFromAnswer } from '../src/bid/screen'

const sample = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../tests/fixtures/profi/response', name), 'utf8'),
  ) as { url: string; body: { data: { orders: Record<string, unknown>[] } } }

type Screen = Record<string, unknown>
const withScreen = (name: string, change: (s: Screen) => void) => {
  const r = sample(name)
  change(r.body.data.orders[0]?.boOrderScreen as Screen)
  return r
}

describe('the order page answer (boOrderScreen, recorded live 24.10.2026)', () => {
  it('FR-LEAD-5: the order page answer gives open, fee and has_bid', () => {
    const r = sample('order-page.json')
    expect(orderScreenFromAnswer(r.url, r.body, '10000001')).toEqual({
      orderId: '10000001',
      open: true,
      disabled: false,
      feeRub: 71,
      hasBid: false,
      // The recorded sample keeps the length of the words only; the live text is «Откликнуться».
      submitText: 'Текст 2 Текс',
      // Live: «Написать клиенту» (tariffsBlock.scrollButtonText, 150 answers read 24.10.2026).
      openerText: 'Текст 18 Текст 1',
      priceRequired: true,
      payment: null,
    })
  })

  it('FR-LEAD-5: with a discount the fee is what this account pays now', () => {
    const r = sample('order-page-discount.json')
    const id = String(r.body.data.orders[0]?._id)
    expect(orderScreenFromAnswer(r.url, r.body, id)).toMatchObject({ feeRub: 1, open: true })
  })

  it('FR-LEAD-5: an order whose bid block is disabled, or which has no form, is closed', () => {
    const blocked = withScreen('order-page.json', (s) => {
      s.disabledBidBlock = { title: 'Заказ закрыт' }
    })
    expect(orderScreenFromAnswer(blocked.url, blocked.body, '10000001')).toMatchObject({
      open: false,
      disabled: true,
    })
    const noForm = withScreen('order-page.json', (s) => {
      s.form = null
      s.bidForms = []
    })
    // No form can be a changed layout or a bid already made: only the disabled block is the site saying «closed».
    expect(orderScreenFromAnswer(noForm.url, noForm.body, '10000001')).toMatchObject({
      open: false,
      disabled: false,
    })
  })

  it('FR-LEAD-8: a bid already on the order, and a payment way in the form, are seen', () => {
    const r = withScreen('order-page.json', (s) => {
      s.hasBid = true
      ;(s.form as { elements: Screen }).elements.paymentMethod = { name: 'payment', value: 'sbp' }
    })
    expect(orderScreenFromAnswer(r.url, r.body, '10000001')).toMatchObject({
      hasBid: true,
      payment: 'other',
    })
  })

  it('FR-LEAD-8: a payment choice that names a bank beside the wallet is not the wallet', () => {
    const r = withScreen('order-page.json', (s) => {
      ;(s.form as { elements: Screen }).elements.paymentMethod = {
        options: [{ label: 'Кошелёк' }, { label: 'СБП', selected: true }],
      }
    })
    expect(orderScreenFromAnswer(r.url, r.body, '10000001')?.payment).toBe('other')
    const wallet = withScreen('order-page.json', (s) => {
      ;(s.form as { elements: Screen }).elements.paymentMethod = { label: 'Кошелёк', value: '354' }
    })
    expect(orderScreenFromAnswer(wallet.url, wallet.body, '10000001')?.payment).toBe('wallet')
  })

  it('FR-LEAD-5: an answer about another order, or another answer, gives nothing', () => {
    const r = sample('order-page.json')
    expect(orderScreenFromAnswer(r.url, r.body, '999')).toBeNull()
    expect(
      orderScreenFromAnswer('https://profi.ru/backoffice/api/x', r.body, '10000001'),
    ).toBeNull()
    expect(orderScreenFromAnswer(r.url, { data: { me: {} } }, '10000001')).toBeNull()
  })
})
