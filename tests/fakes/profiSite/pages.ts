// HTML of the stand-in Profi.ru. Shapes are our guesses until calibration (plan Task 16).
// Bubble classes come from v1 (src/watcher/messageDom.js): cw_iCsdtF ours, cw_cO7-r- client, cw_GK6qZJ system.

export type Layout = { feedKey: string; orderLink: string; bubble: Record<string, string> }

export const NORMAL_LAYOUT: Layout = {
  feedKey: 'items',
  orderLink: 'order-link',
  bubble: {
    specialist: 'cw_iCsdtF',
    client: 'cw_cO7-r-',
    system: 'cw_GK6qZJ',
    strange: 'cw_ZZZ999',
  },
}

export const CHANGED_LAYOUT: Layout = {
  feedKey: 'list',
  orderLink: 'job-link',
  bubble: { specialist: 'x_a1', client: 'x_b2', system: 'x_c3', strange: 'x_d4' },
}

const shell = (title: string, body: string, script = '') => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head>
<body><header><span class="balance" aria-label="Баланс" data-rub="__BALANCE__">__BALANCE__ ₽</span>
<span class="presence __PRESENCE__">присутствие</span></header>
<main>${body}</main><script>${script}</script></body></html>`

export const loginPage = () =>
  shell(
    'Вход на Профи.ру',
    `<h1>Вход на Профи.ру</h1>
<input id="phone" name="phone" placeholder="Телефон" autocomplete="off">
<button id="send-phone">Получить код</button>
<input id="code" name="code" placeholder="Код из СМС" autocomplete="off">
<button id="send-code">Войти</button><p id="error"></p>`,
    `document.getElementById('send-phone').onclick = () => fetch('/login/phone', { method: 'POST', body: JSON.stringify({ phone: document.getElementById('phone').value }) })
document.getElementById('send-code').onclick = async () => {
  const r = await fetch('/login/code', { method: 'POST', body: JSON.stringify({ code: document.getElementById('code').value }) })
  if (r.ok) location.href = '/backoffice/a.php'; else document.getElementById('error').textContent = 'Неверный код'
}`,
  )

export const bannedPage = () => shell('Профиль заблокирован', '<h1>Ваш профиль заблокирован</h1>')

const rtpScript = (rtpUrl: string) => `const sess = (document.cookie.match(/sess=([^;]+)/) || [])[1]
window.__RTP = new WebSocket(${JSON.stringify(rtpUrl)} + '/rtp?sess=' + sess)
window.__RTP.onmessage = () => {}`

export const feedPage = (rtpUrl: string, l: Layout) =>
  shell(
    'Заказы',
    '<ul id="feed"></ul>',
    `${rtpScript(rtpUrl)}
async function load() {
  const data = await (await fetch('/api/feed')).json()
  document.getElementById('feed').innerHTML = (data[${JSON.stringify(l.feedKey)}] || []).map((o) =>
    '<li><a class="${l.orderLink}" data-order-id="' + o.id + '" href="/backoffice/n.php?o=' + o.id + '">' + o.subject + '</a> <span class="city">' + o.city + '</span></li>').join('')
}
load(); window.__RTP.addEventListener('message', load)`,
  )

export type BidLook = {
  payWay: 'wallet' | 'sbp'
  /** The form is closed until its opener is pressed, as on the live page. */
  behindOpener: boolean
  /** A broken site that charges for opening the form (the top bar shows it after a reload). */
  openerCharges: number
  /** The top bar shows that charge at once. */
  openerChargeShown: boolean
  /** The opener leads off the order page (to a payment page without the top bar). */
  openerLeaves: boolean
  /** How many openers the tariff block draws. */
  openers: number
  /**
   * What opens the form: «Продолжить» with the fee beside it, a div as on the live page (maps of 24.10.2026), or the
   * answer's own opener words (tariffsBlock.scrollButtonText).
   */
  opener: 'continue' | 'words'
  /** The amount the «Продолжить» opener shows; null shows the fee. */
  openerAmount: number | null
  /** A widget in a frame of the page asks the backoffice API for another client first (an advert, a similar order). */
  klientDecoy: boolean
}

// The bid block is drawn from the page's own answer (POST /graphql, orders[].boOrderScreen), like the live page of
// 24.10.2026: no field and no <button> at first, a tariff block «orderCard/tariffs» with the tariff card «Отклик • N ₽»,
// «Детали» and the opener «Продолжить» with the fee beside it, all of them divs or links. It opens the form «Комиссия за
// заказ»: the price, the text, the payment footer, the send button.
export const orderPage = (id: string, look: BidLook) =>
  shell(
    'Заказ',
    `<article id="order" data-order-id="${id}"></article><section id="bid"></section>${look.klientDecoy ? '<iframe src="/backoffice/widget.html"></iframe>' : ''}`,
    `fetch('/api/order/${id}').then((r) => r.json()).then((o) => {
  document.getElementById('order').innerHTML = '<h1>' + o.subject + '</h1><p class="text">' + o.description + '</p>'
})
// The client card of the order page: the live page asks the backoffice API for it (getKlientInfo).
fetch('/backoffice/api/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'getKlientInfo', orderId: '${id}' }) })
  .then((r) => r.json()).then((d) => { if (d.data) document.getElementById('order').dataset.klient = d.data.name }).catch(() => {})
fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'orders', variables: { id: '${id}' } }) })
  .then((r) => r.json()).then((d) => {
  const s = d.data && d.data.orders && d.data.orders[0] && d.data.orders[0].boOrderScreen
  const box = document.getElementById('bid')
  if (!s) return
  if (s.hasBid) { box.innerHTML = '<p class="bid-done">Вы откликнулись</p>'; return }
  if (s.disabledBidBlock) { box.innerHTML = '<p class="closed">' + s.disabledBidBlock.title + '</p>'; return }
  const hidden = ${look.behindOpener}
  const t = s.tariffsBlock
  const amount = ${look.openerAmount === null ? 's.price.value' : `'${look.openerAmount}'`}
  const opener = (i) => ${look.opener === 'continue'}
    ? '<div id="bid-opener' + (i ? i : '') + '" class="opener" style="cursor: pointer"><div>Продолжить</div><div>' + amount + ' ₽</div></div>'
    : '<a id="bid-opener' + (i ? i : '') + '" class="opener" href="#bid" style="cursor: pointer">' + t.scrollButtonText + '</a>'
  box.innerHTML = '<div data-testid="orderCard/tariffs"><div>' + t.label + '</div>' +
    '<div class="tariff" style="cursor: pointer"><div>' + t.tariffs[0].title + ' • ' + t.tariffs[0].price.value + '</div><div>Вы платите сразу за предложение услуг, но не каждый отклик приводит к заказу</div></div>' +
    '<a href="#details">' + t.details + '</a>' +
    (hidden ? Array.from({ length: ${look.openers} }, (_, i) => opener(i)).join('') : '') + '</div>' +
    '<form id="bid-form" data-testid="bid_form"' + (hidden ? ' hidden' : '') + '><h3>' + t.formTitle + '</h3>' +
    '<label for="bid-price">Стоимость услуги</label><input id="bid-price" name="stavka" type="text" placeholder="Сумма">' +
    '<label for="bid-text">Предложение или вопрос клиенту</label><textarea id="bid-text" name="comments4client" maxlength="500" placeholder="Расскажите о своём опыте. Опишите, как будете решать задачу клиента, прокомментируйте цену."></textarea>' +
    '<div data-testid="bid_form_footer">К оплате: ' + s.price.value + ' ₽</div>' +
    '<div class="payment-methods"><span class="payment-methods__name">${look.payWay === 'sbp' ? 'СБП' : 'Кошелёк'}</span></div>' +
    '<p class="error"></p><button id="bid-send" type="submit">' + s.form.buttons.submit.text + '</button></form>'
  for (const go of document.querySelectorAll('.opener')) go.onclick = async (e) => {
    e.preventDefault(); await fetch('/api/bid/open', { method: 'POST' })
    if (${look.openerLeaves}) { location.href = '/backoffice/pay.php'; return }
    document.getElementById('bid-form').hidden = false
    const w = document.querySelector('.balance')
    if (${look.openerCharges} && ${look.openerChargeShown} && w) { const left = Number(w.dataset.rub) - ${look.openerCharges}; w.dataset.rub = String(left); w.textContent = left + ' ₽' }
  }
  document.getElementById('bid-form').onsubmit = async (e) => {
    e.preventDefault()
    const r = await fetch('/api/bid', { method: 'POST', body: JSON.stringify({ orderId: '${id}', price: document.getElementById('bid-price').value, text: document.getElementById('bid-text').value }) })
    const a = await r.json()
    if (a.ok) box.innerHTML = '<p class="bid-done">Отклик отправлен</p>'
    else box.querySelector('.error').textContent = a.error || 'Не получилось'
  }
})`,
  )

// A widget page that sits in a frame of the order page and asks the backoffice API for another client first.
export const widgetPage = () =>
  shell(
    'Виджет',
    '<p>Похожие заказы</p>',
    `fetch('/backoffice/api/', { method: 'POST', body: JSON.stringify({ method: 'getKlientInfo', orderId: 'decoy' }) })`,
  )

export const chatsPage = () =>
  shell(
    'Чаты',
    '<ul id="chats"></ul>',
    `fetch('/api/chats').then((r) => r.json()).then((d) => {
  document.getElementById('chats').innerHTML = d.chats.map((c) =>
    '<li><a class="chat-link" data-chat-id="' + c.id + '" data-last="' + (c.last || '') + '" href="/chats/' + c.id + '">' + c.id + '</a> <b class="unread">' + c.unread + '</b></li>').join('')
})`,
  )

export const chatPage = (rtpUrl: string, chatId: string, l: Layout) =>
  shell(
    'Чат',
    `<section id="chat" data-chat-id="${chatId}"></section>`,
    `${rtpScript(rtpUrl)}
const CLASSES = ${JSON.stringify(l.bubble)}
async function load() {
  const d = await (await fetch('/api/chat/${chatId}')).json()
  document.getElementById('chat').innerHTML = d.messages.map((m) =>
    '<div class="cw_msg ' + CLASSES[m.side] + '" data-message-content-id="' + m.id + '" data-sent-at="' + m.ts + '"><div class="cw_xeDn2R"><div class="cw_BFgZYK">' + m.text + '</div></div></div>').join('')
}
load(); window.__RTP.addEventListener('message', load)`,
  )
