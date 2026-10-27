import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clickSubmit, fillForm, readPayment } from '../src/bid/form'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { nodeTestUrl } from './helpers/db'

let ab: AccountBrowser
beforeAll(async () => {
  ab = await openAccountBrowser({
    accountId: 'bid-form-test',
    profileDir: await mkdtemp(join(tmpdir(), 'bf-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
}, 60000)
afterAll(() => ab.close())

// The opened form as the node mapped it on the live site (order 95380709, 25.10.2026 00:16 MSK): a price range
// «От» «До» without names, the text by its placeholder, the footer «К оплате:» with the amount, the payment way and
// «Откликнуться» (payment_methods_form_pay_button). The wallet was 23 ₽, so the footer offered «СБП».
const liveForm = (
  way: string,
  o: { due?: string; send?: string; outside?: string; to?: string } = {},
) => `<header><span aria-label="Баланс">23 ₽</span></header>
<script>window.sent = false; window.upsell = false; window.other = false</script>
<div data-testid="order_card_container">
  ${o.outside ?? ''}
  <div data-testid="bid_window_container">
    <div>Стоимость услуги</div>
    <label>От <input type="text"></label>
    <label>До <input type="text" value="${o.to ?? ''}"></label>
    <textarea placeholder="Расскажите о своём опыте. Опишите, как будете решать задачу клиента, прокомментируйте цену."></textarea>
    <textarea hidden></textarea>
    <div data-testid="bid_form_footer">${o.due ?? '<div>К оплате:</div><div>120 ₽</div>'}${way}
      <button type="button" data-testid="payment_methods_form_pay_button" onclick="window.sent = true">${o.send ?? 'Откликнуться'}</button></div>
  </div>
  <a href="#premium" onclick="window.upsell = true">Отклик можно продвинуть</a>
</div>`

describe('the live bid form (calibrated by the opened-form map)', () => {
  it('FR-LEAD-8: the footer gives the amount due and the payment way it offers', async () => {
    await ab.page.setContent(liveForm('<div>СБП</div>'))
    expect(await readPayment(ab.page, 23)).toEqual({ dueRub: 120, way: 'other', wayText: 'СБП' })
  })

  it('FR-LEAD-8: only a way the footer names as the wallet is the wallet; none, or anything else, is not', async () => {
    await ab.page.setContent(liveForm('<div>Кошелёк</div>'))
    expect((await readPayment(ab.page, 354)).way).toBe('wallet')
    // Old Sara (orders 94430827, 94476795): the wallet labelled by its own amount.
    await ab.page.setContent(liveForm('<div>354 ₽</div>'))
    expect((await readPayment(ab.page, 354)).way).toBe('wallet')
    for (const way of [
      '<div>Недостаточно средств на балансе</div>',
      '<div>Картой</div>',
      '<div>Кошелёк: недостаточно средств</div>',
      '<div>Пополнить кошелёк</div>',
      // A picker: the wallet among other ways is not the wallet.
      '<div class="payment-methods"><span class="payment-methods__name">Кошелёк</span><span>СБП</span></div>',
      // An amount beside the way that only happens to be the wallet's.
      '<div>СБП</div><div><s>354 ₽</s></div>',
    ]) {
      await ab.page.setContent(liveForm(way))
      expect((await readPayment(ab.page, 354)).way).toBe('other')
    }
  })

  it('FR-LEAD-8: a footer that names no way is the wallet only when the wallet covers the amount due (live 27.10)', async () => {
    await ab.page.setContent(liveForm(''))
    expect(await readPayment(ab.page, 5049)).toEqual({ dueRub: 120, way: 'wallet', wayText: null })
    expect((await readPayment(ab.page, 23)).way).toBe('other')
    expect((await readPayment(ab.page, null)).way).toBe('other')
    await ab.page.setContent(liveForm('', { due: '<div>К оплате:</div>' }))
    expect((await readPayment(ab.page, 5049)).way).toBe('other')
  })

  it('FR-LEAD-8: the way is read in the footer only, never from a «payment-methods» block elsewhere', async () => {
    await ab.page.setContent(
      liveForm('<div>СБП</div>', {
        outside:
          '<div class="payment-methods"><span class="payment-methods__name">Кошелёк</span></div>',
      }),
    )
    expect((await readPayment(ab.page, 23)).way).toBe('other')
  })

  it('FR-LEAD-8: the amount due is the footer amount, on its line or on the next, never another line', async () => {
    await ab.page.setContent(liveForm('<div>СБП</div>', { due: '<div>К оплате: 120 ₽</div>' }))
    expect((await readPayment(ab.page, 23)).dueRub).toBe(120)
    await ab.page.setContent(liveForm('<div>Кошелёк 354 ₽</div>', { due: '<div>К оплате:</div>' }))
    expect(await readPayment(ab.page, 354)).toMatchObject({ dueRub: null, way: 'wallet' })
  })

  it('FR-LEAD-8: the price goes to «От», «До» stays empty, the text to its field', async () => {
    await ab.page.setContent(liveForm('<div>Кошелёк</div>'))
    const text = 'Добрый день! Сделаем сайт с онлайн-записью. Какие услуги в приоритете?'
    expect(await fillForm(ab.page, { priceRub: 15000, text })).toBe('ok')
    expect(await ab.page.getByLabel('От', { exact: true }).inputValue()).toBe('15000')
    expect(await ab.page.getByLabel('До', { exact: true }).inputValue()).toBe('')
    expect(await ab.page.locator('textarea').first().inputValue()).toBe(text)
  })

  it('FR-LEAD-8: a «До» the page filled itself is emptied, and a price field outside the form is left alone', async () => {
    await ab.page.setContent(
      liveForm('<div>Кошелёк</div>', {
        to: '50000',
        outside: '<label>Пополнить на <input type="text" placeholder="Сумма"></label>',
      }),
    )
    expect(await fillForm(ab.page, { priceRub: 15000, text: 'Добрый день!' })).toBe('ok')
    expect(await ab.page.getByLabel('От', { exact: true }).inputValue()).toBe('15000')
    expect(await ab.page.getByLabel('До', { exact: true }).inputValue()).toBe('')
    expect(await ab.page.getByPlaceholder('Сумма').inputValue()).toBe('')
  })

  it('FR-LEAD-8: a null price leaves both ends of the range empty', async () => {
    await ab.page.setContent(liveForm('<div>Кошелёк</div>'))
    expect(await fillForm(ab.page, { priceRub: null, text: 'Добрый день!' })).toBe('ok')
    expect(await ab.page.getByLabel('От', { exact: true }).inputValue()).toBe('')
  })

  it('FR-LEAD-8: the send press is the footer’s «Откликнуться», never the promotion beside it', async () => {
    await ab.page.setContent(liveForm('<div>Кошелёк</div>'))
    expect(await clickSubmit(ab.page, 'Откликнуться')).toBe('clicked')
    expect(
      await ab.page.evaluate(() => {
        const w = window as { sent?: boolean; upsell?: boolean }
        return [w.sent ?? false, w.upsell ?? false]
      }),
    ).toEqual([true, false])
  })

  it('FR-LEAD-8: an «Откликнуться» outside the form is never pressed, even when the form has no such button', async () => {
    await ab.page.setContent(
      liveForm('<div>Кошелёк</div>', {
        send: 'Отправить',
        outside: '<button type="button" onclick="window.other = true">Откликнуться</button>',
      }),
    )
    expect(await clickSubmit(ab.page, 'Откликнуться')).toBe('clicked')
    expect(
      await ab.page.evaluate(() => {
        const w = window as { sent?: boolean; other?: boolean }
        return [w.sent ?? false, w.other ?? false]
      }),
    ).toEqual([true, false])
  })
})
