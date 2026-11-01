import { inTelegram } from '../api'
import { back, currentPath } from './router'

/**
 * The Mini App's frame (M7 design 2, pult v2 design 7). Opened from the bot's «Открыть пульт» (/pult), the pult loads
 * Telegram's script, tells Telegram it is ready, takes Telegram's light or dark theme and its «Назад» button. In a
 * plain browser none of this loads.
 */

type TelegramWebApp = {
  ready(): void
  expand(): void
  colorScheme?: 'light' | 'dark'
  onEvent(name: string, fn: () => void): void
  BackButton: { show(): void; hide(): void; onClick(fn: () => void): void }
}

const SCRIPT = 'https://telegram.org/js/telegram-web-app.js'

function webApp(): TelegramWebApp | null {
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp ?? null
}

function syncBack(app: TelegramWebApp): void {
  const path = currentPath()
  if (path === '/' || path === '/inbox') app.BackButton.hide()
  else app.BackButton.show()
}

export function startTelegram(): void {
  if (!inTelegram()) return
  document.documentElement.dataset.telegram = 'on'
  const s = document.createElement('script')
  s.src = SCRIPT
  s.async = true
  s.onload = () => {
    const app = webApp()
    if (!app) return
    app.ready()
    app.expand()
    const theme = () => {
      if (app.colorScheme) document.documentElement.dataset.theme = app.colorScheme
    }
    theme()
    app.onEvent('themeChanged', theme)
    app.BackButton.onClick(() => back())
    syncBack(app)
    window.addEventListener('popstate', () => syncBack(app))
  }
  document.head.appendChild(s)
}
