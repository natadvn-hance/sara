import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../App'
import { startInMemory } from '../app/router'
import '../design/tokens.css'
import '../design/pult.css'
import * as f from './fixtures'

/**
 * The demo of the pult for the preview page: the real screens over made-up data, with no core behind them. Built
 * apart (`pnpm --filter @sara/web build:demo`), never part of the pult itself.
 */

const PRESS: Record<string, string> = {
  bid: 'Отклик ушёл (в демо ничего не тратится).',
  skip: 'Пропустила.',
  send: 'Отправила клиенту (в демо ничего не уходит).',
  take: 'Клиент твой: Сара больше не пишет ему сама.',
}

function answer(method: string, url: URL, body: unknown): unknown {
  const p = url.pathname
  if (method === 'POST') {
    const press = /^\/api\/tasks\/[^/]+\/([a-z]+)$/.exec(p)
    if (press?.[1]) return { message: PRESS[press[1]] ?? 'Готово.' }
    if (p.startsWith('/api/settings/'))
      return {
        message:
          (body as { value?: unknown })?.value === false ? 'Поставила на паузу.' : 'Сохранила.',
      }
    if (p.endsWith('/close')) return { message: 'Разговор закрыт.' }
    if (p.endsWith('/return')) return { message: 'Клиент снова у Сары.' }
    return { message: 'Готово.' }
  }
  if (p === '/api/today') return f.today(Number(url.searchParams.get('period') ?? 7))
  if (p === '/api/leads') return f.leadQueue
  if (p.startsWith('/api/leads/')) return f.lead(decodeURIComponent(p.split('/')[3] ?? ''))
  if (p === '/api/conversations') return f.convList
  if (p.startsWith('/api/conversations/')) return f.conv(p.split('/')[3] ?? '')
  if (p === '/api/analytics')
    return f.analytics(Number(url.searchParams.get('year') ?? new Date().getFullYear()))
  if (p === '/api/mind') return f.mind
  if (p.startsWith('/api/mind/')) return f.mindRecord(decodeURIComponent(p.split('/')[3] ?? ''))
  if (p === '/api/settings') return f.settings
  if (p === '/api/system') return f.system
  if (p === '/api/accounts') return f.accounts
  if (p === '/api/setup') return { next: 'done', completed: [] }
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
  today: '/today',
  leads: '/leads',
  lead: '/leads/95210417',
  chats: '/conversations',
  chat: '/conversations/c-veronika',
  analytics: '/analytics',
  mind: '/mind',
  prefs: '/settings',
  health: '/health',
}
startInMemory(VIEWS[window.location.hash.slice(1)] ?? '/today')
const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
