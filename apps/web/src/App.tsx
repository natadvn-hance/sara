import { lazy, type ReactNode, Suspense, useEffect } from 'react'
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
import { ClientsScreen } from './screens/Clients'
import { HealthScreen } from './screens/Health'
import { InboxScreen } from './screens/Inbox'
import { JournalScreen } from './screens/Journal'
import { LeadsScreen } from './screens/Leads'
import { MeetingsScreen } from './screens/Meetings'
import { MindScreen } from './screens/Mind'
import { NoticesScreen } from './screens/Notices'
import { SearchScreen } from './screens/Search'
import { SettingsScreen } from './screens/Settings'
import { TodayScreen } from './screens/Today'

/** The voice app, loaded only when its address is opened (ADR-028). */
const TalkApp = lazy(() => import('./talk/TalkApp').then((m) => ({ default: m.TalkApp })))

/** The first page: the wizard until the setup is done, then the Inbox (pult v2 design 2). */
function Home() {
  useEffect(() => {
    api<SetupState>('/api/setup')
      .then((s) => go(s.next === 'done' ? '/inbox' : '/setup'))
      .catch(() => go('/setup'))
  }, [])
  return <p className="p-4">Загружаю…</p>
}

/** The accounts' own pages keep their addresses (links already sent in Telegram, the rules pages of M3). */
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
  inbox: () => <InboxScreen />,
  leads: () => <LeadsScreen />,
  clients: () => <ClientsScreen />,
  today: () => <TodayScreen />,
  meetings: () => <MeetingsScreen />,
  mind: () => <MindScreen />,
  settings: () => <SettingsScreen />,
  accounts: (path) => <Accounts path={path} />,
  health: () => <HealthScreen />,
  journal: () => <JournalScreen />,
  notices: () => <NoticesScreen />,
  search: () => <SearchScreen />,
  analytics: () => <AnalyticsScreen />,
  more: () => <MoreScreen />,
  // The old address of the chats keeps opening the clients.
  conversations: (path) => {
    go(path.replace('/conversations', '/clients'))
    return null
  },
}

export function App() {
  const path = usePath()
  if (path.startsWith('/setup')) return <SetupPage />
  if (path.startsWith('/login')) return <LoginPage />
  // The voice app has its own page (talk.html); this way it opens in the dev server and after the login too.
  if (path === '/talk' || path.startsWith('/talk?'))
    return (
      <Suspense fallback={null}>
        <TalkApp />
      </Suspense>
    )
  if (path === '/' || path === '') return <Home />
  const screen = SCREENS[sectionOf(path)]
  if (!screen) return <Home />
  // The pages match the path alone; their own query (`?run=`) they read from the address themselves.
  return <Shell>{screen(path.split('?')[0] ?? path)}</Shell>
}
