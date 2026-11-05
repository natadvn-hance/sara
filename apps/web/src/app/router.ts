import { useEffect, useState } from 'react'

/**
 * Paths of the pult, the same in the browser and in the Mini App (pult v2 design 2). The demo preview has no real
 * address bar: there the path lives in memory.
 */
const memory: { on: boolean; path: string } = { on: false, path: '/' }

export function startInMemory(path: string): void {
  memory.on = true
  memory.path = path
}

export function currentPath(): string {
  return memory.on ? memory.path : `${window.location.pathname}${window.location.search}`
}

export function navigate(path: string): void {
  if (memory.on) memory.path = path
  else window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo?.({ top: 0 })
}

/** Back in history; in memory (the demo) and with nothing behind, home. */
export function back(): void {
  if (!memory.on && window.history.length > 1) window.history.back()
  else navigate('/')
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath)
  useEffect(() => {
    const on = () => setPath(currentPath())
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return path
}

/** The section a path belongs to, for the menu and the tabs. */
export function sectionOf(path: string): string {
  const first = (path.split('?')[0] ?? '').split('/')[1] ?? ''
  if (first === '' || first === 'inbox') return 'inbox'
  return first
}

/** `/leads/95147898` → '95147898'; null on the list itself. */
export function idOf(path: string, section: string): string | null {
  const m = new RegExp(`^/${section}/([^/?]+)/?(?:\\?.*)?$`).exec(path)
  return m?.[1] ? decodeURIComponent(m[1]) : null
}

/** The `focus` of `/settings?focus=thresholds`: the block a link wants the screen to open on. */
export function focusOf(path: string): string | null {
  const i = path.indexOf('?')
  if (i < 0) return null
  return new URLSearchParams(path.slice(i + 1)).get('focus')
}

/** The `q` of `/search?q=...`. */
export function queryOf(path: string): string {
  const i = path.indexOf('?')
  if (i < 0) return ''
  return new URLSearchParams(path.slice(i + 1)).get('q') ?? ''
}
