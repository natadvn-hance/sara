import type { TodayView } from '@sara/shared'
import { type ReactNode, useEffect, useState } from 'react'
import { Icon } from '../ui/icons'
import { A, Dot } from '../ui/kit'
import { useScreen, useToast } from './data'
import { sectionOf, usePath } from './router'

/**
 * The frame of every screen (M7 design 2): on a wide screen the menu on the left with Sara's state at its foot, on a
 * phone the bar on top and five tabs at the bottom.
 */

type Item = {
  id: string
  to: string
  title: string
  icon: string
  count?: (t: TodayView) => number
}

const WORK: Item[] = [
  { id: 'today', to: '/today', title: 'Сегодня', icon: 'today' },
  { id: 'leads', to: '/leads', title: 'Заявки', icon: 'leads', count: (t) => t.waiting.leads },
  {
    id: 'conversations',
    to: '/conversations',
    title: 'Переписки',
    icon: 'chat',
    count: (t) => t.waiting.drafts,
  },
  { id: 'analytics', to: '/analytics', title: 'Итоги', icon: 'chart' },
]
export const SARA_SECTIONS: Item[] = [
  { id: 'mind', to: '/mind', title: 'Разум', icon: 'mind' },
  { id: 'settings', to: '/settings', title: 'Настройки', icon: 'settings' },
  { id: 'health', to: '/health', title: 'Здоровье', icon: 'health' },
  { id: 'accounts', to: '/accounts', title: 'Аккаунты', icon: 'user' },
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

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => applyTheme(theme), [theme])
  const next: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' }
  const name: Record<Theme, string> = { system: 'как в системе', dark: 'тёмная', light: 'светлая' }
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

export function Shell({ children }: { children: ReactNode }) {
  const path = usePath()
  const section = sectionOf(path)
  const today = useScreen<TodayView>('/api/today?period=7').data
  const isMore = section === 'more' || SARA_SECTIONS.some((s) => s.id === section)
  return (
    <div className="shell">
      <aside className="side" aria-label="Разделы">
        <A to="/today" className="brand">
          <span className="brand-glyph" aria-hidden="true">
            S
          </span>
          <span>
            Sara <small>пульт</small>
          </span>
        </A>
        <nav className="nav-group" aria-label="Работа">
          <span className="nav-label">Работа</span>
          {WORK.map((i) => (
            <A key={i.id} to={i.to} className="nav-link" current={section === i.id}>
              <Icon name={i.icon} />
              {i.title}
              <Badge n={today && i.count?.(today)} />
            </A>
          ))}
        </nav>
        <nav className="nav-group" aria-label="Сара">
          <span className="nav-label">Сара</span>
          {SARA_SECTIONS.map((i) => (
            <A key={i.id} to={i.to} className="nav-link" current={section === i.id}>
              <Icon name={i.icon} />
              {i.title}
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
        <A to="/today" className="brand">
          <span className="brand-glyph" aria-hidden="true">
            S
          </span>
          Sara
        </A>
        {today ? (
          <A to="/health" className={`pill tone-${today.state.tone}`}>
            <Dot tone={today.state.tone} live />
            <span className="row-title" style={{ maxWidth: '52vw', fontWeight: 400 }}>
              {today.state.text}
            </span>
          </A>
        ) : null}
      </header>

      <main className="main">{children}</main>

      <nav className="tabs" aria-label="Разделы">
        {WORK.map((i) => (
          <A key={i.id} to={i.to} className="tab" current={section === i.id}>
            <Icon name={i.icon} />
            {i.title}
            <Badge n={today && i.count?.(today)} />
          </A>
        ))}
        <A to="/more" className="tab" current={isMore}>
          <Icon name="more" />
          Ещё
        </A>
      </nav>
      <Toaster />
    </div>
  )
}

/** «Ещё» on a phone: Sara's own sections and the theme. */
export function MoreScreen() {
  return (
    <div className="page">
      <header className="head reveal">
        <div className="head-main">
          <h1 className="h1">Ещё</h1>
        </div>
      </header>
      <section className="card reveal" aria-label="Разделы">
        <div className="list">
          {SARA_SECTIONS.map((i) => (
            <A key={i.id} to={i.to} className="row">
              <span className="score">
                <Icon name={i.icon} />
              </span>
              <span className="row-main">
                <span className="row-title">{i.title}</span>
              </span>
              <span className="row-end">
                <Icon name="right" />
              </span>
            </A>
          ))}
        </div>
        <ThemeSwitch />
      </section>
    </div>
  )
}
