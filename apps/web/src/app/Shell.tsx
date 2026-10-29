import type { InboxView, NoticeList, TodayView } from '@sara/shared'
import { type ReactNode, useEffect, useState } from 'react'
import { inTelegram } from '../api'
import { Icon } from '../ui/icons'
import { A, Dot } from '../ui/kit'
import { useLive, useScreen, useToast } from './data'
import { navigate, sectionOf, usePath } from './router'

/**
 * The frame of every screen (pult v2 design 2): on a wide screen the menu on the left with Sara's state at its
 * foot, the search and the bell on top; on a phone and in the Mini App the bar on top and five tabs at the bottom.
 */

export type Item = { id: string; to: string; title: string; icon: string }

export const WORK: Item[] = [
  { id: 'inbox', to: '/inbox', title: 'Входящие', icon: 'inbox' },
  { id: 'leads', to: '/leads', title: 'Заявки', icon: 'leads' },
  { id: 'clients', to: '/clients', title: 'Клиенты', icon: 'users' },
  { id: 'today', to: '/today', title: 'Сегодня', icon: 'today' },
]
export const MORE: Item[] = [
  { id: 'meetings', to: '/meetings', title: 'Встречи', icon: 'calendar' },
  { id: 'mind', to: '/mind', title: 'Разум', icon: 'mind' },
  { id: 'settings', to: '/settings', title: 'Настройки', icon: 'settings' },
  { id: 'health', to: '/health', title: 'Состояние', icon: 'health' },
  { id: 'journal', to: '/journal', title: 'Журнал', icon: 'list' },
  { id: 'notices', to: '/notices', title: 'Уведомления', icon: 'bell' },
]
/** Every section, for the search: a section opens from the search too (FR-UI-1). */
export const SECTIONS: Item[] = [
  ...WORK,
  ...MORE,
  { id: 'analytics', to: '/analytics', title: 'Итоги', icon: 'chart' },
]

type Theme = 'system' | 'dark' | 'light'
const THEME_KEY = 'sara.theme'

function readTheme(): Theme {
  try {
    const t = window.localStorage.getItem(THEME_KEY)
    return t === 'dark' || t === 'light' ? t : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => applyTheme(theme), [theme])
  const next: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' }
  const name: Record<Theme, string> = { system: 'как в системе', dark: 'тёмная', light: 'светлая' }
  // Inside Telegram the colors are Telegram's own theme; the switch would fight it.
  if (inTelegram()) return null
  return (
    <button
      type="button"
      className="nav-link"
      onClick={() => {
        const t = next[theme]
        setTheme(t)
        try {
          window.localStorage.setItem(THEME_KEY, t)
        } catch {}
      }}
    >
      <Icon name="moon" />
      Тема: {name[theme]}
    </button>
  )
}

function Badge({ n }: { n: number | undefined }) {
  return n ? <span className="badge">{n > 99 ? '99+' : n}</span> : null
}

function Toaster() {
  const text = useToast()
  return (
    <div aria-live="polite">
      {text ? (
        <div className="toast" role="status">
          {text}
        </div>
      ) : null}
    </div>
  )
}

/** The search box: `/` puts the cursor here on a computer; Enter opens the results. */
function SearchBox({ compact }: { compact?: boolean }) {
  const [q, setQ] = useState('')
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return
      const t = e.target as HTMLElement | null
      if (t && /^(input|textarea)$/i.test(t.tagName)) return
      e.preventDefault()
      document.getElementById('search')?.focus()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  if (compact)
    return (
      <A to="/search" className="icon-btn" aria-label="Поиск">
        <Icon name="search" />
      </A>
    )
  return (
    <form
      className="search"
      aria-label="Поиск"
      onSubmit={(e) => {
        e.preventDefault()
        if (q.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(q.trim())}`)
      }}
    >
      <Icon name="search" />
      <input
        id="search"
        aria-label="Поиск по заявкам, клиентам и разуму"
        placeholder="Поиск: номер заказа, клиент, тема…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
    </form>
  )
}

function Bell({ unseen }: { unseen: number | undefined }) {
  return (
    <A
      to="/notices"
      className="icon-btn"
      aria-label={`Уведомления${unseen ? `, новых ${unseen}` : ''}`}
    >
      <Icon name="bell" />
      <Badge n={unseen} />
    </A>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePath()
  const section = sectionOf(path)
  useLive()
  const today = useScreen<TodayView>('/api/today?period=7', 60_000).data
  const inbox = useScreen<InboxView>('/api/inbox').data
  const notices = useScreen<NoticeList>('/api/notices?state=new').data
  const counts: Record<string, number | undefined> = {
    inbox: inbox ? inbox.items.length : undefined,
    leads: inbox?.counts.leads,
    clients: inbox?.counts.drafts,
    notices: notices?.unseen,
  }
  const isMore = section === 'more' || MORE.some((s) => s.id === section) || section === 'analytics'
  return (
    <div className="shell">
      <aside className="side" aria-label="Разделы">
        <A to="/inbox" className="brand">
          <span className="brand-glyph" aria-hidden="true">
            S
          </span>
          <span>
            Sara <small>пульт</small>
          </span>
        </A>
        <SearchBox />
        <nav className="nav-group" aria-label="Работа">
          <span className="nav-label">Работа</span>
          {WORK.map((i) => (
            <A key={i.id} to={i.to} className="nav-link" current={section === i.id}>
              <Icon name={i.icon} />
              {i.title}
              <Badge n={counts[i.id]} />
            </A>
          ))}
        </nav>
        <nav className="nav-group" aria-label="Сара">
          <span className="nav-label">Сара</span>
          {MORE.map((i) => (
            <A key={i.id} to={i.to} className="nav-link" current={section === i.id}>
              <Icon name={i.icon} />
              {i.title}
              <Badge n={counts[i.id]} />
            </A>
          ))}
        </nav>
        <div className="side-foot">
          {today ? (
            <A to="/health" className={`state tone-${today.state.tone}`}>
              <Dot tone={today.state.tone} live />
              <span>{today.state.text}</span>
            </A>
          ) : null}
          <ThemeSwitch />
        </div>
      </aside>

      <header className="topbar">
        <A to="/inbox" className="brand">
          <span className="brand-glyph" aria-hidden="true">
            S
          </span>
          Sara
        </A>
        {today ? (
          <A to="/health" className={`pill tone-${today.state.tone}`}>
            <Dot tone={today.state.tone} live />
            <span className="row-title" style={{ maxWidth: '40vw', fontWeight: 400 }}>
              {today.state.text}
            </span>
          </A>
        ) : null}
        <span className="topbar-end">
          <SearchBox compact />
          <Bell unseen={notices?.unseen} />
        </span>
      </header>

      <main className="main">{children}</main>

      <nav className="tabs" aria-label="Разделы">
        {WORK.map((i) => (
          <A key={i.id} to={i.to} className="tab" current={section === i.id}>
            <Icon name={i.icon} />
            {i.title}
            <Badge n={counts[i.id]} />
          </A>
        ))}
        <A to="/more" className="tab" current={isMore}>
          <Icon name="more" />
          Ещё
          <Badge n={counts.notices} />
        </A>
      </nav>
      <Toaster />
    </div>
  )
}

/** «Ещё» on a phone: Sara's own sections and the theme. */
export function MoreScreen() {
  const notices = useScreen<NoticeList>('/api/notices?state=new').data
  return (
    <div className="page">
      <header className="head reveal">
        <div className="head-main">
          <h1 className="h1">Ещё</h1>
        </div>
      </header>
      <section className="card reveal" aria-label="Разделы">
        <div className="list">
          {[...MORE, { id: 'analytics', to: '/analytics', title: 'Итоги', icon: 'chart' }].map(
            (i) => (
              <A key={i.id} to={i.to} className="row">
                <span className="score">
                  <Icon name={i.icon} />
                </span>
                <span className="row-main">
                  <span className="row-title">{i.title}</span>
                </span>
                <span className="row-end">
                  {i.id === 'notices' ? <Badge n={notices?.unseen} /> : null}
                  <Icon name="right" />
                </span>
              </A>
            ),
          )}
        </div>
        <ThemeSwitch />
      </section>
    </div>
  )
}
