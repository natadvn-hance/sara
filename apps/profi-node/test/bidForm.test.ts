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
const liveForm = (way: string) => `<header><span aria-label="Баланс">23 ₽</span></header>
<div data-testid="order_card_container">
  <div data-testid="bid_window_container">
    <div>Стоимость услуги</div>
    <label>От <input type="text"></label>
    <label>До <input type="text"></label>
    <textarea placeholder="Расскажите о своём опыте. Опишите, как будете решать задачу клиента, прокомментируйте цену."></textarea>
    <textarea hidden></textarea>
    <div data-testid="bid_form_footer"><div>К оплате:</div><div>120 ₽</div>${way}
      <button type="button" data-testid="payment_methods_form_pay_button" onclick="window.sent = true">Откликнуться</button></div>
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
    for (const way of ['', '<div>Недостаточно средств на балансе</div>', '<div>Картой</div>']) {
      await ab.page.setContent(liveForm(way))
      expect((await readPayment(ab.page, 354)).way).toBe('other')
    }
  })

  it('FR-LEAD-8: the price goes to «От», «До» stays empty, the text to its field', async () => {
    await ab.page.setContent(liveForm('<div>Кошелёк</div>'))
    const text = 'Добрый день! Сделаем сайт с онлайн-записью. Какие услуги в приоритете?'
    expect(await fillForm(ab.page, { priceRub: 15000, text })).toBe('ok')
    expect(await ab.page.getByLabel('От', { exact: true }).inputValue()).toBe('15000')
    expect(await ab.page.getByLabel('До', { exact: true }).inputValue()).toBe('')
    expect(await ab.page.locator('textarea').first().inputValue()).toBe(text)
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
})
