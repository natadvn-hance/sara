import { type ReactNode, useEffect } from 'react'
import { api, go, type SetupState } from './api'
import { sectionOf, usePath } from './app/router'
import { MoreScreen, Shell } from './app/Shell'
import { AccountsPage } from './pages/Accounts'
import { LiveScreenPage } from './pages/LiveScreen'
import { LoginPage } from './pages/Login'
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

/** The first page: the wizard until the setup is done, then the Inbox (pult v2 design 2). */
function Home() {
  useEffect(() => {
    api<SetupState>('/api/setup')
      .then((s) => go(s.next === 'done' ? '/inbox' : '/setup'))
      .catch(() => go('/setup'))
  }, [])
  return <p className="p-4">Загружаю…</p>
}

/** The accounts' own pages: the live login screen keeps its address (links already sent in Telegram). */
function Accounts({ path }: { path: string }) {
  const login = /^\/accounts\/([^/]+)\/login/.exec(path)
  if (login?.[1]) return <LiveScreenPage accountId={decodeURIComponent(login[1])} />
  const direction = /^\/accounts\/([^/]+)\/direction/.exec(path)
  if (direction?.[1]) {
    go(`/settings/rules/${direction[1]}${path.replace(/^\/accounts\/[^/]+\/direction/, '')}`)
    return null
  }
  return <AccountsPage />
}

const SCREENS: Record<string, (path: string) => ReactNode> = {
  inbox: () => <InboxScreen />,
  leads: () => <LeadsScreen />,
  clients: () => <ClientsScreen />,
  today: () => <TodayScreen />,
  meetings: () => <MeetingsScreen />,
  mind: () => <MindScreen />,
  settings: (path) =>
    path.startsWith('/accounts') ? <Accounts path={path} /> : <SettingsScreen />,
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
  if (path === '/' || path === '') return <Home />
  const screen = SCREENS[sectionOf(path)]
  if (!screen) return <Home />
  return <Shell>{screen(path)}</Shell>
}
