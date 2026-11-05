import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import { startInMemory } from '../app/router'
import '../design/tokens.css'
import '../design/pult.css'
import * as f from './fixtures'
import * as g from './fixtures2'

/**
 * The demo of the pult for the preview page: the real screens over made-up data, with no core behind them. Built
 * apart (`pnpm --filter @sara/web build:demo`), never part of the pult itself.
 */

const PRESS: Record<string, string> = {
  bid: 'Откликаюсь через 10 секунд (в демо ничего не тратится).',
  skip: 'Пропустила, причину записала.',
  send: 'Отправила клиенту (в демо ничего не уходит).',
  take: 'Клиент твой: Сара больше не пишет ему сама.',
  close: 'Закрыла.',
  apply: 'Применила, теперь правила v4.',
  drop: 'Хорошо, оставляю v3.',
  want: 'Пишу черновик, пришлю карточку.',
  open: 'Прислала карточку заявки.',
  answer: 'Записала.',
  cancel: 'Отменила, отклик не ушёл.',
  recheck: 'Перечитала заказ: открыт, цена та же.',
  decide: 'Записала решение по предложению.',
  outcome: 'Записала итог сделки.',
  note: 'Заметку сохранила.',
  done: 'Убрала.',
  seen: 'Просмотрено.',
}

/** The demo's own state: a held bid shows its count, a decided task leaves the Inbox. */
const state = { held: new Map<string, string>(), gone: new Set<string>() }

function answer(method: string, url: URL, body: unknown): unknown {
  const p = url.pathname
  if (method === 'POST') {
    const bid = /^\/api\/leads\/([^/]+)\/bid$/.exec(p)
    if (bid?.[1]) {
      state.held.set(bid[1], new Date(Date.now() + 10_000).toISOString())
      setTimeout(() => {
        state.held.delete(bid[1] as string)
        state.gone.add(`task:t-${bid[1]}`)
      }, 10_000)
      return { message: PRESS.bid }
    }
    const cancel = /^\/api\/leads\/([^/]+)\/bid\/cancel$/.exec(p)
    if (cancel?.[1]) {
      state.held.delete(cancel[1])
      return { message: PRESS.cancel }
    }
    const skip = /^\/api\/leads\/([^/]+)\/skip$/.exec(p)
    if (skip?.[1]) {
      state.gone.add(`task:t-${skip[1]}`)
      return { message: PRESS.skip }
    }
    const task = /^\/api\/tasks\/([^/]+)\/([a-z]+)$/.exec(p)
    if (task?.[1] && task[2]) {
      state.gone.add(`task:${task[1]}`)
      return { message: PRESS[task[2]] ?? 'Готово.' }
    }
    const q = /^\/api\/questions\/([^/]+)\/([a-z]+)$/.exec(p)
    if (q?.[1]) {
      state.gone.add(`question:${q[1]}`)
      return { message: q[2] === 'skip' ? 'Хорошо, не важно.' : PRESS.answer }
    }
    const last = p.split('/').pop() ?? ''
    if (p.startsWith('/api/settings/threshold/')) return { message: 'Сохранила как правила v4.' }
    if (p.startsWith('/api/settings/'))
      return {
        message:
          (body as { value?: unknown })?.value === false ? 'Поставила на паузу.' : 'Сохранила.',
      }
    if (p.startsWith('/api/notices/')) return { message: PRESS[last] ?? 'Готово.' }
    if (p === '/api/meetings') return { message: 'Встречу записала.' }
    return { message: PRESS[last] ?? 'Готово.' }
  }
  if (p === '/api/inbox')
    return {
      ...g.inbox,
      items: g.inbox.items
        .filter((i) => !state.gone.has(i.id))
        .map((i) => {
          const held = i.entity?.kind === 'lead' ? state.held.get(i.entity.id) : undefined
          return held ? { ...i, hold: { executeAt: held } } : i
        }),
    }
  if (p === '/api/notices') return g.notices
  if (p === '/api/today') return f.today(Number(url.searchParams.get('period') ?? 7))
  if (p === '/api/leads') {
    // Two numbers (Boris, 29.10.2026): the fit is today's score, the chance is still being worked out.
    const order = url.searchParams.get('order') ?? 'combined'
    const queue = f.leadQueue.queue.map((r) => ({
      ...r,
      scores: {
        fit: { value: r.score, reasons: [] },
        chance: { value: null, reasons: [] },
        combined: r.score,
      },
      heldUntil: state.held.get(r.id) ?? null,
    }))
    if (order === 'chance') queue.sort((a, b) => a.feeRub - b.feeRub)
    return { ...f.leadQueue, queue }
  }
  if (p.startsWith('/api/leads/')) {
    const id = decodeURIComponent(p.split('/')[3] ?? '')
    const v = f.lead(id)
    const held = state.held.get(id)
    return v
      ? {
          ...v,
          hold: held ? { requestId: 'r1', executeAt: held } : null,
          score: v.score
            ? {
                ...v.score,
                confidence: 0.82,
                scores: {
                  fit: {
                    value: v.score.value,
                    reasons: [v.score.reason, ...v.score.axes.map((a) => a.why)],
                  },
                  chance: { value: null, reasons: [] },
                  combined: v.score.value,
                },
              }
            : null,
        }
      : null
  }
  if (p === '/api/clients') return g.clientList
  if (p.startsWith('/api/clients/')) return g.client(p.split('/')[3] ?? '')
  if (p === '/api/meetings') return g.meetings
  if (p === '/api/journal') return g.journal
  if (p.startsWith('/api/journal/trace/')) return g.trace
  if (p === '/api/search') return g.search(url.searchParams.get('q') ?? '')
  if (p === '/api/analytics')
    return f.analytics(Number(url.searchParams.get('year') ?? new Date().getFullYear()))
  if (p === '/api/mind') return f.mind
  if (p.startsWith('/api/mind/')) return f.mindRecord(decodeURIComponent(p.split('/')[3] ?? ''))
  if (p === '/api/settings') return f.settings
  if (p.startsWith('/api/settings/threshold/')) {
    // Invented counts, a few per kind, the same shape the service answers with.
    const now = { marketing: 40, sites: 55, other: 50 }
    const base = { marketing: 86, sites: 25, other: 37 }
    const kinds = Object.fromEntries(
      (['marketing', 'sites', 'other'] as const).map((k) => {
        const value = Number(url.searchParams.get(k) ?? now[k])
        const step = (now[k] - value) / 5
        return [
          k,
          {
            value,
            current: now[k],
            cardsNow: base[k],
            cardsWould: Math.max(0, Math.round(base[k] * (1 + step * 0.25))),
            lostYes: value > now[k] ? Math.min(3, Math.round(-step)) : 0,
            gainedNo: value < now[k] ? Math.round(step) : 0,
          },
        ]
      }),
    )
    return { version: 4, kinds }
  }
  if (p === '/api/system')
    return {
      ...f.system,
      deploy: { version: '0.4.2', startedAt: new Date(Date.now() - 5 * 3600_000).toISOString() },
    }
  if (p === '/api/accounts') return f.accounts
  if (p === '/api/setup') return { next: 'done', completed: [] }
  if (p === '/api/stream') return null
  return null
}

window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    'https://demo.local',
  )
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  await new Promise((r) => setTimeout(r, 120))
  const data = answer(method, url, body)
  return new Response(JSON.stringify(data ?? { error: 'Такого нет.' }), {
    status: data ? 200 : 404,
    headers: { 'content-type': 'application/json' },
  })
}

/** A bare #token in the preview's link opens that screen (the viewer keeps #settings for itself, hence #prefs). */
const VIEWS: Record<string, string> = {
  inbox: '/inbox',
  today: '/today',
  leads: '/leads',
  lead: '/leads/95210417',
  clients: '/clients',
  client: '/clients/c-veronika',
  meetings: '/meetings',
  notices: '/notices',
  journal: '/journal',
  trace: '/journal/trace/corr-95210417',
  search: '/search?q=керамик',
  analytics: '/analytics',
  mind: '/mind',
  prefs: '/settings',
  thresholds: '/settings?focus=thresholds',
  health: '/health',
}
startInMemory(VIEWS[window.location.hash.slice(1)] ?? '/inbox')

/** Said on every screen: these are not Boris's orders, so the preview is never taken for the pult on his data. */
function DemoBanner() {
  return (
    <div
      role="note"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        padding: '6px 16px',
        background: '#fff1c2',
        color: '#4a3800',
        fontSize: 13,
        textAlign: 'center',
      }}
    >
      Превью на выдуманных данных: заявки, клиенты и суммы здесь не настоящие. Настоящие в пульте
      Сары.
    </div>
  )
}
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <DemoBanner />
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}
