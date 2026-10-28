import { type ReactNode, useEffect } from 'react'
import { api, go, type SetupState } from './api'
import { sectionOf, usePath } from './app/router'
import { MoreScreen, Shell } from './app/Shell'
import { AccountsPage } from './pages/Accounts'
import { CalibrationPage } from './pages/Calibration'
import { DirectionPage } from './pages/Direction'
import { LiveScreenPage } from './pages/LiveScreen'
import { LoginPage } from './pages/Login'
import { OnboardingPage } from './pages/Onboarding'
import { RecomputePage } from './pages/Recompute'
import { SetupPage } from './pages/Setup'
import { AnalyticsScreen } from './screens/Analytics'
import { ConversationsScreen } from './screens/Conversations'
import { HealthScreen } from './screens/Health'
import { LeadsScreen } from './screens/Leads'
import { MindScreen } from './screens/Mind'
import { SettingsScreen } from './screens/Settings'
import { TodayScreen } from './screens/Today'

/** The first page: the wizard until the setup is done, then «Сегодня». */
function Home() {
  useEffect(() => {
    api<SetupState>('/api/setup')
      .then((s) => go(s.next === 'done' ? '/today' : '/setup'))
      .catch(() => go('/setup'))
  }, [])
  return <p className="p-4">Загружаю…</p>
}

function Accounts({ path }: { path: string }) {
  const login = /^\/accounts\/([^/]+)\/login/.exec(path)
  if (login?.[1]) return <LiveScreenPage accountId={decodeURIComponent(login[1])} />
  const calibration = /^\/accounts\/([^/]+)\/direction\/calibration\/?$/.exec(path)
  if (calibration?.[1]) return <CalibrationPage accountId={decodeURIComponent(calibration[1])} />
  const recompute = /^\/accounts\/([^/]+)\/direction\/recompute\/?$/.exec(path)
  if (recompute?.[1]) return <RecomputePage accountId={decodeURIComponent(recompute[1])} />
  const onboarding = /^\/accounts\/([^/]+)\/direction\/onboarding\/?$/.exec(path)
  if (onboarding?.[1]) return <OnboardingPage accountId={decodeURIComponent(onboarding[1])} />
  const direction = /^\/accounts\/([^/]+)\/direction\/?$/.exec(path)
  if (direction?.[1]) return <DirectionPage accountId={decodeURIComponent(direction[1])} />
  return <AccountsPage />
}

const SCREENS: Record<string, (path: string) => ReactNode> = {
  today: () => <TodayScreen />,
  leads: () => <LeadsScreen />,
  conversations: () => <ConversationsScreen />,
  analytics: () => <AnalyticsScreen />,
  mind: () => <MindScreen />,
  settings: () => <SettingsScreen />,
  health: () => <HealthScreen />,
  accounts: (path) => <Accounts path={path} />,
  more: () => <MoreScreen />,
}

export function App() {
  const path = usePath()
  if (path.startsWith('/setup')) return <SetupPage />
  if (path.startsWith('/login')) return <LoginPage />
  if (path === '/' || path === '') return <Home />
  const screen = SCREENS[sectionOf(path)]
  if (!screen) return <Home />
  return <Shell>{screen(path)}</Shell>
}
