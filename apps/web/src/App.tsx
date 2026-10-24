import { useEffect, useState } from 'react'
import { api, go, type SetupState } from './api'
import { AccountsPage } from './pages/Accounts'
import { DirectionPage } from './pages/Direction'
import { HealthPage } from './pages/Health'
import { LiveScreenPage } from './pages/LiveScreen'
import { LoginPage } from './pages/Login'
import { OnboardingPage } from './pages/Onboarding'
import { RecomputePage } from './pages/Recompute'
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
  const login = /^\/accounts\/([^/]+)\/login/.exec(path)
  if (login?.[1]) return <LiveScreenPage accountId={decodeURIComponent(login[1])} />
  const recompute = /^\/accounts\/([^/]+)\/direction\/recompute\/?$/.exec(path)
  if (recompute?.[1]) return <RecomputePage accountId={decodeURIComponent(recompute[1])} />
  const onboarding = /^\/accounts\/([^/]+)\/direction\/onboarding\/?$/.exec(path)
  if (onboarding?.[1]) return <OnboardingPage accountId={decodeURIComponent(onboarding[1])} />
  const direction = /^\/accounts\/([^/]+)\/direction\/?$/.exec(path)
  if (direction?.[1]) return <DirectionPage accountId={decodeURIComponent(direction[1])} />
  if (path.startsWith('/accounts')) return <AccountsPage />
  return <Home />
}
