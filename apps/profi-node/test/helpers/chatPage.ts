import type { Page } from 'playwright'

// A chat page of the real Profi.ru as old Sara's code knew it (src/negotiator/openChat.js, src/watcher/messageDom.js of
// the old folder): bubbles with data-message-content-id and a side class, the words in .cw_xeDn2R .cw_BFgZYK, the
// field textarea[placeholder="Сообщение"], and a send button that is the last button of the field's third ancestor
// div (a microphone while the field is empty, a send icon when it has text). Guessed where old Sara did not say.

export type FakeSide = 'specialist' | 'client' | 'system' | 'unknown'
export type FakeMessage = { id: string; side: FakeSide; text: string }
export const SIDE_CLASS: Record<FakeSide, string> = {
  specialist: 'cw_iCsdtF',
  client: 'cw_cO7-r-',
  system: 'cw_GK6qZJ',
  unknown: 'cw_ZZZ999',
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export type FakeChat = {
  messages: FakeMessage[]
  /** The message box: drawn (default), without the field, without buttons, or not at all (a closed chat). */
  box?: 'normal' | 'no_field' | 'no_buttons' | 'none'
  /** Words left in the field from before (a draft). */
  draft?: string
  /** The field rewrites what is put in it (here it drops digits), so a text never stands in it whole. */
  mangle?: boolean
  /**
   * What the send button does with text in the field: the message appears at once (works), after a while (late), or
   * never although the press went through (swallowed).
   */
  send?:
    | 'works'
    | 'late'
    | 'swallowed'
    // The bubble shows at once with a temporary id and a sending mark, then the site refuses it (it goes away)...
    | 'optimistic_fail'
    // ...or takes it (the bubble gets its real id and loses the mark)...
    | 'optimistic_ok'
    // ...or a bubble with the real-looking id is drawn and then goes away by itself.
    | 'vanishing'
  /** Pressing Enter in the field sends too, as in many messengers. */
  enterSends?: boolean
  /** The id the next bubble gets. */
  nextId?: string
  /** The button does not change with the text in the field (a button that is no microphone-and-send one). */
  staticButton?: boolean
  /** A client bubble that is drawn into the open page this many milliseconds after it has loaded. */
  laterBubble?: { id: string; text: string; afterMs: number }
  /** A client bubble that arrives in the open page the moment something is typed into the field. */
  arriveOnInput?: { id: string; text: string }
}

export function bubble(m: FakeMessage): string {
  return `<div class="cw_msg ${SIDE_CLASS[m.side]}" data-message-content-id="${m.id}"><div class="cw_xeDn2R"><div class="cw_BFgZYK">${esc(m.text)}</div></div><span class="cw_time">12:00</span></div>`
}

/** The page, with a script that behaves like the box: it reports a sent text to /__press. */
export function chatHtml(chatId: string, c: FakeChat): string {
  const box = c.box ?? 'normal'
  const composer =
    box === 'none'
      ? ''
      : `<div class="cw_composer"><div class="cw_inner"><div class="cw_row">
${box === 'no_field' ? '' : `<textarea placeholder="Сообщение" rows="1">${esc(c.draft ?? '')}</textarea>`}
${
  box === 'no_buttons'
    ? ''
    : `<button type="button" aria-label="Прикрепить файл"><svg width="12" height="12"></svg></button>
<input type="file" hidden accept="image/*,.pdf" multiple>
<button type="button" id="main" data-mode="${c.draft ? 'send' : 'mic'}" aria-label="Голосовое сообщение"><svg width="12" height="12"></svg></button>`
}
</div></div></div>`
  const enter = c.enterSends
    ? "field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } })"
    : ''
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Чат</title></head><body>
<header><a href="/backoffice/r.php">Иван Клиентов</a></header>
<div id="list" class="cw_list">${c.messages.map(bubble).join('')}</div>
${composer}
<script>
const SIDE = ${JSON.stringify(SIDE_CLASS)}
const ARRIVE = ${JSON.stringify(c.arriveOnInput ?? null)}
const field = document.querySelector('textarea')
const main = document.getElementById('main')
let next = ${JSON.stringify(c.nextId ?? 'new-1')}
const morph = () => { if (main && field && !${JSON.stringify(c.staticButton ?? false)}) main.dataset.mode = field.value ? 'send' : 'mic' }
const add = (text, id, pending) => {
  const el = document.createElement('div')
  el.className = 'cw_msg ' + SIDE.specialist + (pending ? ' cw_pending' : '')
  if (pending) el.setAttribute('data-status', 'sending')
  el.setAttribute('data-message-content-id', id || next)
  el.innerHTML = '<div class="cw_xeDn2R"><div class="cw_BFgZYK"></div></div><span class="cw_time">12:01</span>'
  el.querySelector('.cw_BFgZYK').textContent = text
  document.getElementById('list').appendChild(el)
  return el
}
async function submit() {
  const text = field.value
  if (!text) return
  field.value = ''
  morph()
  const how = ${JSON.stringify(c.send ?? 'works')}
  await fetch('/__press?chat=${chatId}&how=' + how, { method: 'POST', body: text })
  if (how === 'swallowed') return
  if (how === 'late') await new Promise((r) => setTimeout(r, 1500))
  if (how === 'optimistic_fail') { const el = add(text, 'tmp-1', true); setTimeout(() => el.remove(), 900); return }
  if (how === 'optimistic_ok') {
    const el = add(text, 'tmp-1', true)
    setTimeout(() => { el.setAttribute('data-message-content-id', next); el.classList.remove('cw_pending'); el.removeAttribute('data-status') }, 800)
    return
  }
  if (how === 'vanishing') { const el = add(text); setTimeout(() => el.remove(), 400); return }
  add(text)
}
if (field) {
  let arrived = false
  field.addEventListener('input', () => {
    if (ARRIVE && !arrived) {
      arrived = true
      const el = document.createElement('div')
      el.className = 'cw_msg ' + SIDE.client
      el.setAttribute('data-message-content-id', ARRIVE.id)
      el.innerHTML = '<div class="cw_xeDn2R"><div class="cw_BFgZYK"></div></div><span class="cw_time">12:02</span>'
      el.querySelector('.cw_BFgZYK').textContent = ARRIVE.text
      document.getElementById('list').appendChild(el)
    }
    ${c.mangle ? "field.value = field.value.replace(/[0-9]/g, '')" : ''}
    morph()
  })
  ${enter}
}
const LATER = ${JSON.stringify(c.laterBubble ?? null)}
if (LATER) setTimeout(() => {
  const el = document.createElement('div')
  el.className = 'cw_msg ' + SIDE.client
  el.setAttribute('data-message-content-id', LATER.id)
  el.innerHTML = '<div class="cw_xeDn2R"><div class="cw_BFgZYK"></div></div>'
  el.querySelector('.cw_BFgZYK').textContent = LATER.text
  document.getElementById('list').appendChild(el)
}, LATER.afterMs)
if (main) main.addEventListener('click', () => { if (main.dataset.mode === 'send') submit() })
</script></body></html>`
}

export type FakeProfi = {
  chats: Map<string, FakeChat>
  /** Every press of the send button that carried text, in order. */
  presses: { chat: string; how: string; text: string }[]
  /** Every chat page the tab loaded, in order. */
  opened: string[]
}

export const FAKE_ORIGIN = 'http://profi.test'

/** Serves the fake site to a Playwright page: nothing leaves the machine. */
export async function serveFakeProfi(page: Page, site: FakeProfi): Promise<void> {
  await page.route(`${FAKE_ORIGIN}/**`, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname === '/backoffice/r.php' && url.searchParams.get('id')) {
      const id = url.searchParams.get('id') ?? ''
      site.opened.push(id)
      const chat = site.chats.get(id)
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: chat ? chatHtml(id, chat) : '<!doctype html><title>Нет такого чата</title>',
      })
    }
    if (url.pathname === '/__press') {
      const id = url.searchParams.get('chat') ?? ''
      const how = url.searchParams.get('how') ?? ''
      const text = req.postData() ?? ''
      site.presses.push({ chat: id, how, text })
      const chat = site.chats.get(id)
      // The site keeps the message unless it swallowed it: a reload of the page shows it.
      if (chat && !['swallowed', 'optimistic_fail', 'vanishing'].includes(how)) {
        const at = chat.nextId ?? 'new-1'
        chat.messages.push({ id: at, side: 'specialist', text })
        chat.nextId = `new-${Number(at.replace(/\D/g, '')) + 1}`
      }
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Заказы</title><a href="/backoffice/n.php">Заказы</a>',
    })
  })
}
