import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { readFormMap } from '../src/eyes/formMap'
import { nodeTestUrl } from './helpers/db'

let ab: AccountBrowser
beforeAll(async () => {
  ab = await openAccountBrowser({
    accountId: 'form-map-test',
    profileDir: await mkdtemp(join(tmpdir(), 'fm-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
}, 60000)
afterAll(() => ab.close())

// A guess at the October form (one price field, the text, the send button); the recorded maps calibrate it.
const ORDER = `<header><span aria-label="Баланс">354 ₽</span></header>
<main>
  <h2>Описание</h2>
  <p>Оплата наличными, бюджет 5 000 ₽. Кошелёк не предлагать.</p>
  <p>Ирина Петрова</p>
  <form data-testid="bid_form">
    <label for="p">Стоимость услуги</label>
    <input id="p" name="stavka" type="text" placeholder="Сумма" value="секрет-значение" required>
    <select name="edizm" aria-label="ед. изм."><option>за услугу</option><option>в час</option></select>
    <label>Предложение или вопрос клиенту
      <textarea name="comments4client" maxlength="500" placeholder="Расскажите о своём опыте."></textarea>
    </label>
    <input type="hidden" name="price_hsh" value="hash-value">
    <div data-testid="bid_form_footer"><span>К оплате: 71 ₽</span></div>
    <div class="payment-methods"><span class="payment-methods__name">Кошелёк</span></div>
    <button type="button">Продолжить</button>
    <button type="submit" data-testid="bid_submit">Откликнуться</button>
  </form>
</main>`

describe('the bid form map (calibration, M2 design 5.B)', () => {
  it('FR-LEAD-8: the bid form map keeps fields, buttons and payment lines, never values or client text', async () => {
    await ab.page.setContent(ORDER)
    await ab.page.fill('textarea', 'Мой черновик отклика')
    const map = await readFormMap(ab.page)
    expect(map?.what).toBe('bid_form')
    expect(map?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'input',
          type: 'text',
          name: 'stavka',
          label: 'Стоимость услуги',
          placeholder: 'Сумма',
          required: true,
          visible: true,
        }),
        expect.objectContaining({
          tag: 'textarea',
          name: 'comments4client',
          label: 'Предложение или вопрос клиенту',
          maxLength: 500,
          visible: true,
        }),
        expect.objectContaining({
          tag: 'select',
          aria: 'ед. изм.',
          options: ['за услугу', 'в час'],
        }),
        expect.objectContaining({
          tag: 'input',
          type: 'hidden',
          name: 'price_hsh',
          visible: false,
        }),
      ]),
    )
    expect(map?.buttons.map((b) => b.text)).toEqual(['Продолжить', 'Откликнуться'])
    expect(map?.buttons[1]).toMatchObject({ testid: 'bid_submit', visible: true, disabled: false })
    const lines = map?.payment.map((p) => p.text) ?? []
    expect(lines).toEqual(expect.arrayContaining(['354 ₽', 'К оплате: 71 ₽', 'Кошелёк']))
    expect(map?.testids).toEqual(expect.arrayContaining(['bid_form', 'bid_form_footer']))
    const json = JSON.stringify(map)
    for (const secret of [
      'Оплата наличными',
      'Ирина',
      'секрет-значение',
      'hash-value',
      'Мой черновик',
    ])
      expect(json).not.toContain(secret)
  })

  it('FR-LEAD-8: outside the bid form only site words of a known shape are kept, never the client’s', async () => {
    await ab.page.setContent(`<main>
      <div class="order-params"><div class="payment-info">Оплата наличными после встречи</div></div>
      <button class="chip">Ирина Петрова</button>
      <div><span>Бюджет</span><span>15 000 ₽</span></div>
      <div class="files"><span>Договор Ирины</span><input type="file" name="doc"></div>
      <button type="button">Продолжить</button>
      <div class="bid-box"><span>Ваша цена</span><input name="stavka" type="text">
        <textarea name="comments4client"></textarea>
        <div class="payment-methods"><span>Оплата с кошелька</span></div>
        <button>Отправить предложение</button></div>
    </main>`)
    const map = await readFormMap(ab.page)
    const json = JSON.stringify(map)
    for (const secret of ['Ирина', 'Ирины', 'Оплата наличными', '15 000'])
      expect(json).not.toContain(secret)
    expect(map?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'stavka', near: 'Ваша цена' }),
        expect.objectContaining({ name: 'doc', near: null }),
      ]),
    )
    expect(map?.buttons.map((b) => [b.text, b.inForm])).toEqual([
      ['Продолжить', false],
      ['Отправить предложение', true],
    ])
    expect(map?.payment.map((p) => p.text)).toContain('Оплата с кошелька')
  })

  it('FR-LEAD-8: a form hidden behind «Продолжить» is mapped as hidden and nothing is clicked', async () => {
    await ab.page.setContent(`<main>
      <button id="go" onclick="window.clicked = true; document.getElementById('f').hidden = false">Продолжить</button>
      <form id="f" hidden><textarea name="comments4client" placeholder="Расскажите"></textarea>
      <button>Откликнуться</button></form></main>`)
    const map = await readFormMap(ab.page)
    expect(map?.fields).toEqual([
      expect.objectContaining({ tag: 'textarea', name: 'comments4client', visible: false }),
    ])
    expect(map?.buttons).toEqual([
      expect.objectContaining({ text: 'Продолжить', visible: true }),
      expect.objectContaining({ text: 'Откликнуться', visible: false }),
    ])
    expect(await ab.page.evaluate(() => (window as { clicked?: boolean }).clicked ?? false)).toBe(
      false,
    )
  })
})
