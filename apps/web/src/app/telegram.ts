const KEY = 'sara.initData'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The Mini App's signed launch data (M7 design, section 7). Telegram puts it into the address hash as
 * `tgWebAppData=<initData>`; it is kept in the tab's session storage, so a reload inside the Mini App still has it.
 * Null in a plain browser.
 */
export function launchData(hash: string, storage: Store | null): string | null {
  const fresh = new URLSearchParams(hash.replace(/^#/, '')).get('tgWebAppData')
  if (fresh) {
    try {
      storage?.setItem(KEY, fresh)
    } catch {
      // A private tab may refuse storage; this load still has the data.
    }
    return fresh
  }
  try {
    return storage?.getItem(KEY) ?? null
  } catch {
    return null
  }
}

/** The part of Telegram's `window.Telegram.WebApp` the pult uses. */
export type TelegramApp = {
  ready(): void
  expand(): void
  close(): void
  openLink(url: string): void
  BackButton: {
    show(): void
    hide(): void
    onClick(f: () => void): void
    offClick(f: () => void): void
  }
}

let initData: string | null = null

/** Read once at start, before the first request, so the first request already carries the signature. */
export function startTelegram(w: Window = window): string | null {
  let storage: Storage | null = null
  try {
    storage = w.sessionStorage
  } catch {
    storage = null
  }
  initData = launchData(w.location.hash, storage)
  if (initData) {
    w.document.documentElement.classList.add('mini')
    const s = w.document.createElement('script')
    s.src = 'https://telegram.org/js/telegram-web-app.js'
    s.async = true
    s.onload = () => {
      const app = telegramApp()
      app?.ready()
      app?.expand()
      w.dispatchEvent(new Event('telegram-ready'))
    }
    w.document.head.appendChild(s)
  }
  return initData
}

/** The signed launch data of this Mini App, or null in a browser. */
export function telegramInitData(): string | null {
  return initData
}

export function insideTelegram(): boolean {
  return initData !== null
}

/** Telegram's own object once its script has loaded; null in a browser or before the script. */
export function telegramApp(): TelegramApp | null {
  if (!initData) return null
  return (window as unknown as { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp ?? null
}
