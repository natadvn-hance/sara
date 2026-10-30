/** The stand's page at /stand/ (docs/ops/staging.md): the fake Profi.ru for Boris, plain HTML over /stand/api. */
export const STAND_PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Профи.ру понарошку</title>
<style>
  :root { --bg: #f6f5f2; --card: #fff; --ink: #1d1d1b; --muted: #6b6a66; --line: #e3e1db; --accent: #2f6f4f; --warn: #a3471f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --card: #20201e; --ink: #ecebe6; --muted: #9c9b95; --line: #34332f; --accent: #6fbf93; --warn: #e08a5f; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  .muted { color: var(--muted); font-size: 13px; }
  .warn { color: var(--warn); }
  section, .order { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin: 12px 0; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button, select, textarea, input { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
  select { max-width: 100%; min-width: 0; }
  button { cursor: pointer; }
  button.main { background: var(--accent); border-color: var(--accent); color: #fff; }
  textarea { width: 100%; min-height: 56px; resize: vertical; }
  .msg { padding: 6px 10px; border-radius: 10px; margin: 4px 0; max-width: 88%; white-space: pre-wrap; }
  .msg.specialist { background: color-mix(in srgb, var(--accent) 14%, transparent); margin-left: auto; }
  .msg.client { background: var(--bg); border: 1px solid var(--line); }
  .msg.system { color: var(--muted); font-size: 13px; }
  .tag { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
</style>
</head>
<body>
<main>
  <h1>Профи.ру понарошку</h1>
  <div class="muted">Тестовый стенд Сары: отклики бесплатные, клиенты ненастоящие. <a href="/">Пульт стенда</a></div>
  <section>
    <div class="row">
      <span>Кошелёк: <b id="balance">…</b> ₽</span>
      <button id="refill">Пополнить до 5000</button>
      <span class="muted" id="usage"></span>
    </div>
    <div class="warn" id="model"></div>
    <div class="warn" id="error"></div>
  </section>
  <section>
    <h2>Подкинуть заказ</h2>
    <div class="row">
      <select id="from"></select>
      <select id="behaviour"></select>
      <button class="main" id="add">Подкинуть</button>
    </div>
    <div class="row muted" style="margin-top:8px">
      Новые клиенты по умолчанию: <select id="default"></select>
    </div>
  </section>
  <section>
    <h2>Сценарии</h2>
    <div class="row" id="scenarios"></div>
  </section>
  <div id="orders"></div>
</main>
<script>
const $ = (id) => document.getElementById(id)
const drafts = {}
let data = null
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
async function call(path, body) {
  $('error').textContent = ''
  const r = await fetch('/stand/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) { $('error').textContent = j.error || 'Не вышло (' + r.status + ')'; throw new Error(j.error) }
  return j
}
function options(list, picked) {
  return list.map((o) => '<option value="' + esc(o.id) + '"' + (o.id === picked ? ' selected' : '') + '>' + esc(o.title) + '</option>').join('')
}
function render() {
  $('balance').textContent = data.balance
  $('usage').textContent = 'модель-клиент сегодня: ' + data.usage.today + ' из ' + data.usage.limit
  $('model').textContent = data.modelReady ? '' : 'Нет токена Claude у ядра стенда: пройди мастер в пульте, пока клиенты-модели молчат.'
  if (!$('from').dataset.done) {
    const from = [{ id: 'real', title: 'Копия реального заказа (' + data.realCount + ')' }, { id: 'sample', title: 'Выдуманный, любой' }]
      .concat(data.samples.map((s) => ({ id: 'sample:' + s.id, title: 'Выдуманный: ' + s.title })))
    $('from').innerHTML = options(from, data.realCount ? 'real' : 'sample')
    $('behaviour').innerHTML = '<option value="">клиент: как по умолчанию</option>' + options(data.behaviours.map((b) => ({ id: b.id, title: 'клиент: ' + b.title })))
    $('from').dataset.done = '1'
  }
  // A field Boris is typing in or a list he opened is not drawn over.
  const busy = document.activeElement && ['TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
  if (busy) return
  $('default').innerHTML = options(data.behaviours, data.defaultBehaviour)
  $('scenarios').innerHTML = data.scenarios.map((s) => '<button data-scenario="' + esc(s.name) + '">' + esc(s.title) + '</button>').join('') || '<span class="muted">нет</span>'
  $('orders').innerHTML = data.orders.map((o) => {
    const p = o.plan || {}
    const msgs = o.messages.map((m) => '<div class="msg ' + esc(m.author) + '">' + esc(m.text) + '</div>').join('') || '<div class="muted">Чата ещё нет: он появится с откликом Сары.</div>'
    return '<div class="order" data-id="' + o.id + '">' +
      '<div class="row"><b>' + esc(o.title) + '</b><span class="tag">' + esc(o.source) + '</span>' +
      '<span class="tag">' + (o.open ? 'открыт' : 'закрыт') + '</span>' + (o.has_bid ? '<span class="tag">отклик есть</span>' : '') +
      (data.waiting.includes(o.id) ? '<span class="tag">клиент скоро ответит</span>' : '') + '</div>' +
      '<div class="muted">№ ' + o.id + ' · ' + esc(o.category) + ' · клиент ' + esc(o.client_name || 'без имени') + ' · отклик ' + o.bid_price_rub + ' ₽</div>' +
      (p.note ? '<div class="warn">' + esc(p.note) + '</div>' : '') +
      '<div style="margin:8px 0">' + msgs + '</div>' +
      '<textarea placeholder="Написать за клиента">' + esc(drafts[o.id] || '') + '</textarea>' +
      '<div class="row" style="margin-top:6px"><button class="main" data-act="client">Отправить от клиента</button>' +
      '<button data-act="read">Прочитал</button><button data-act="typing">Печатает</button><button data-act="close">Закрыть заказ</button>' +
      '<span class="muted">клиент:</span><select data-act="plan">' + options(data.behaviours, p.behaviour) + '</select></div></div>'
  }).join('')
}
async function refresh() {
  try { data = await call('state'); render() } catch {}
}
$('refill').onclick = () => call('wallet', { balance: 5000 }).then(refresh)
$('add').onclick = () => {
  const b = { from: $('from').value }
  if ($('behaviour').value) b.behaviour = $('behaviour').value
  call('orders', b).then(refresh)
}
$('default').onchange = (e) => call('default', { behaviour: e.target.value }).then(refresh)
$('scenarios').onclick = (e) => {
  const name = e.target.dataset && e.target.dataset.scenario
  if (name) call('scenario', { name }).then(refresh)
}
$('orders').oninput = (e) => {
  const o = e.target.closest('.order')
  if (o && e.target.tagName === 'TEXTAREA') drafts[o.dataset.id] = e.target.value
}
$('orders').onclick = (e) => {
  const act = e.target.dataset && e.target.dataset.act
  const o = e.target.closest('.order')
  if (!act || !o || act === 'plan') return
  const id = o.dataset.id
  if (act === 'client') {
    const text = (drafts[id] || '').trim()
    if (!text) return
    call('chats/' + id + '/client', { text }).then(() => { drafts[id] = ''; e.target.blur(); refresh() })
  } else call('chats/' + id + '/' + act, {}).then(refresh)
}
$('orders').onchange = (e) => {
  const o = e.target.closest('.order')
  if (o && e.target.dataset.act === 'plan') call('chats/' + o.dataset.id + '/plan', { behaviour: e.target.value }).then(refresh)
}
refresh()
setInterval(refresh, 4000)
</script>
</body>
</html>
`
