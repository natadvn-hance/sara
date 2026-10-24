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
<body><header><span class="balance" data-rub="__BALANCE__">__BALANCE__ ₽</span>
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

// The bid form as the October site describes it in its order answer (boOrderScreen.form): one price field, the
// text, the send button. Until the recorded maps say otherwise it opens with «Продолжить», as in September.
const bidForm = `<button id="bid-continue" type="button" onclick="fetch('/api/bid/continue', { method: 'POST' }); document.getElementById('bid-form').hidden = false">Продолжить</button>
<form id="bid-form" data-testid="bid_form" hidden onsubmit="return false">
<label for="bid-price">Стоимость услуги</label><input id="bid-price" name="stavka" type="text" placeholder="Сумма">
<label for="bid-text">Предложение или вопрос клиенту</label><textarea id="bid-text" name="comments4client" maxlength="500" placeholder="Расскажите о своём опыте. Опишите, как будете решать задачу клиента, прокомментируйте цену."></textarea>
<div data-testid="bid_form_footer">К оплате: <span class="due"></span> ₽</div>
<button type="submit">Откликнуться</button></form>`

export const orderPage = (id: string) =>
  shell(
    'Заказ',
    `<article id="order" data-order-id="${id}"></article>${bidForm}`,
    `fetch('/api/order/${id}').then((r) => r.json()).then((o) => {
  document.getElementById('order').innerHTML = '<h1>' + o.subject + '</h1><p class="text">' + o.description + '</p>'
  document.querySelector('#bid-form .due').textContent = o.price
})`,
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
