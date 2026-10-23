import { useEffect, useState } from 'react'
import { api, go, type SetupState } from './api'
import { HealthPage } from './pages/Health'
import { LoginPage } from './pages/Login'
import { SetupPage } from './pages/Setup'

function usePath(): string {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const on = () => setPath(window.location.pathname)
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return path
}

function Home() {
  useEffect(() => {
    api<SetupState>('/api/setup')
      .then((s) => go(s.next === 'done' ? '/health' : '/setup'))
      .catch(() => go('/setup'))
  }, [])
  return <p className="p-4">Загружаю…</p>
}

export function App() {
  const path = usePath()
  if (path.startsWith('/setup')) return <SetupPage />
  if (path.startsWith('/login')) return <LoginPage />
  if (path.startsWith('/health')) return <HealthPage />
  return <Home />
}
