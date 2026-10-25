import { SECTIONS } from '@sara/shared'
import { type ReactNode, useEffect, useState } from 'react'
import { go } from '../api'
import { Link } from '../components/list'
import { Button } from '../components/ui/button'
import { useAuthLost } from './auth'
import { isTabRoot, type Route, sectionOf, type Tab, tabOf } from './router'
import { insideTelegram, telegramApp } from './telegram'

const TABS: { id: Tab; title: string; path: string }[] = [
  { id: 'today', title: 'Сегодня', path: '/' },
  { id: 'leads', title: 'Заявки', path: '/leads' },
  { id: 'clients', title: 'Клиенты', path: '/clients' },
  { id: 'settings', title: 'Настройки', path: '/settings' },
]

/** Telegram's script loads after the app starts; screens that need it wait for this. */
function useTelegramApp() {
  const [app, setApp] = useState(telegramApp)
  useEffect(() => {
    if (app || !insideTelegram()) return
    const on = () => setApp(telegramApp())
    window.addEventListener('telegram-ready', on)
    return () => window.removeEventListener('telegram-ready', on)
  }, [app])
  return app
}

/** The system «Назад» of Telegram on every screen deeper than a tab. */
function useBackButton(show: boolean) {
  const app = useTelegramApp()
  useEffect(() => {
    if (!app) return
    if (!show) {
      app.BackButton.hide()
      return
    }
    const back = () => (window.history.length > 1 ? window.history.back() : go('/'))
    app.BackButton.onClick(back)
    app.BackButton.show()
    return () => {
      app.BackButton.offClick(back)
      app.BackButton.hide()
    }
  }, [app, show])
}

/** Inside the Mini App a link to another site (Profi.ru) opens through Telegram, not inside the app. */
function useOutsideLinks(on: boolean) {
  useEffect(() => {
    if (!on) return
    const click = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.(
        'a[target="_blank"]',
      ) as HTMLAnchorElement | null
      const app = telegramApp()
      if (!a || !app) return
      e.preventDefault()
      app.openLink(a.href)
    }
    document.addEventListener('click', click)
    return () => document.removeEventListener('click', click)
  }, [on])
}

function SideMenu({ active }: { active: string | null }) {
  return (
    <nav
      aria-label="Разделы"
      className="sticky top-0 hidden h-dvh w-56 shrink-0 overflow-y-auto border-r border-border bg-surface px-3 py-6 lg:block"
    >
      <p className="px-3 pb-4 font-display text-xl">Сара</p>
      <ul className="grid gap-0.5">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <Link
              href={s.path}
              aria-current={active === s.id ? 'page' : undefined}
              className={`block rounded-md px-3 py-2 ${active === s.id ? 'bg-bg font-medium text-accent' : 'hover:bg-bg'}`}
            >
              {s.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function TabBar({ active, onlyNarrow }: { active: Tab; onlyNarrow: boolean }) {
  return (
    <nav
      aria-label="Вкладки"
      className={`fixed inset-x-0 bottom-0 z-10 grid grid-cols-4 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] ${onlyNarrow ? 'lg:hidden' : ''}`}
    >
      {TABS.map((t) => (
        <Link
          key={t.id}
          href={t.path}
          aria-current={active === t.id ? 'page' : undefined}
          className={`flex min-h-12 items-center justify-center text-sm ${active === t.id ? 'font-medium text-accent' : 'text-muted'}`}
        >
          {t.title}
        </Link>
      ))}
    </nav>
  )
}

/** The Mini App's signature is no longer accepted: the app must be opened again from the chat. */
function Reopen() {
  return (
    <main className="mx-auto grid max-w-sm gap-4 px-4 py-10">
      <h1 className="font-display text-2xl">Открой приложение заново</h1>
      <p>Подпись Telegram устарела. Закрой Сару и открой её снова кнопкой «Сара» в чате.</p>
      <div>
        <Button onClick={() => telegramApp()?.close()}>Закрыть</Button>
      </div>
    </main>
  )
}

/**
 * One app, two shells (M7 design, section 2). In a browser: the side menu of all sections on a wide screen, the
 * four tabs on a narrow one. In Telegram: always the four tabs, Telegram's colours and its «Назад».
 */
export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const mini = insideTelegram()
  const lost = useAuthLost()
  useBackButton(mini && !isTabRoot(route.screen))
  useOutsideLinks(mini)
  if (lost) return <Reopen />
  return (
    <div className={mini ? 'min-h-dvh' : 'min-h-dvh lg:flex'}>
      {mini ? null : <SideMenu active={sectionOf(route.screen)} />}
      <div className={`min-w-0 flex-1 pb-20 ${mini ? '' : 'lg:pb-0'}`}>{children}</div>
      <TabBar active={tabOf(route.screen)} onlyNarrow={!mini} />
    </div>
  )
}
