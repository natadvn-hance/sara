import { useEffect, useState } from 'react'

/**
 * Paths of the pult, the same in the browser and later in the Mini App (M7 design 4). The demo preview has no real
 * address bar: there the path lives in memory.
 */
const memory: { on: boolean; path: string } = { on: false, path: '/' }

export function startInMemory(path: string): void {
  memory.on = true
  memory.path = path
}

export function currentPath(): string {
  return memory.on ? memory.path : window.location.pathname
}

export function navigate(path: string): void {
  if (memory.on) memory.path = path
  else window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo?.({ top: 0 })
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
  const first = path.split('/')[1] ?? ''
  if (first === '' || first === 'today') return 'today'
  if (first === 'accounts') return 'accounts'
  return first
}

/** `/leads/95147898` → '95147898'; null on the list itself. */
export function idOf(path: string, section: string): string | null {
  const m = new RegExp(`^/${section}/([^/]+)/?$`).exec(path)
  return m?.[1] ? decodeURIComponent(m[1]) : null
}
