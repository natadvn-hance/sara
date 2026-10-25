import { lazy, Suspense, useEffect, useState } from 'react'
import { matchRoute, type Route } from './app/router'
import { Shell } from './app/Shell'
import { Loading } from './components/states'
import { AccountsPage } from './pages/Accounts'
import { HealthPage } from './pages/Health'
import { LoginPage } from './pages/Login'
import { NotFoundPage, SectionPage, SettingsPage, TodayPage } from './pages/Sections'
import { SetupPage } from './pages/Setup'

// Screens that are not tabs load when opened, so the first screen on a phone stays small (NFR-PERF-2).
const DirectionPage = lazy(() =>
  import('./pages/Direction').then((m) => ({ default: m.DirectionPage })),
)
const OnboardingPage = lazy(() =>
  import('./pages/Onboarding').then((m) => ({ default: m.OnboardingPage })),
)
const RecomputePage = lazy(() =>
  import('./pages/Recompute').then((m) => ({ default: m.RecomputePage })),
)
const LiveScreenPage = lazy(() =>
  import('./pages/LiveScreen').then((m) => ({ default: m.LiveScreenPage })),
)

function usePath(): string {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const on = () => setPath(window.location.pathname)
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return path
}

function ScreenView({ route }: { route: Route }) {
  const id = route.params.id ?? ''
  switch (route.screen) {
    case 'today':
      return <TodayPage />
    case 'accounts':
    case 'account':
      return <AccountsPage />
    case 'liveLogin':
      return <LiveScreenPage accountId={id} />
    case 'direction':
      return <DirectionPage accountId={id} />
    case 'onboarding':
      return <OnboardingPage accountId={id} />
    case 'recompute':
      return <RecomputePage accountId={id} />
    case 'health':
      return <HealthPage />
    case 'settings':
      return <SettingsPage />
    case 'inbox':
      return <SectionPage title="Входящие" hint="Здесь соберётся всё, что ждёт твоего решения." />
    case 'leads':
    case 'lead':
      return <SectionPage title="Заявки" hint="Очередь заявок с откликом в одно нажатие." />
    case 'clients':
    case 'client':
      return <SectionPage title="Клиенты" hint="Переписка с клиентами и черновики Сары." />
    case 'meetings':
    case 'meeting':
      return <SectionPage title="Встречи" hint="Созвоны впереди и их итоги." />
    case 'mind':
    case 'knowledge':
    case 'lesson':
      return <SectionPage title="Разум" hint="Что Сара знает и как говорит." />
    case 'training':
    case 'trainingItem':
      return <SectionPage title="Тренажёр" hint="Тренировки Сары на типовых клиентах." />
    case 'exams':
    case 'exam':
      return <SectionPage title="Экзамены" hint="Готовность Сары по сценариям." />
    case 'analytics':
      return <SectionPage title="Аналитика" hint="Воронка, деньги и скорость." />
    case 'switch':
      return (
        <SectionPage title="Переключение с v1" hint="Части, которые новая Сара берёт на себя." />
      )
    case 'journal':
    case 'trace':
      return <SectionPage title="Журнал" hint="Всё, что произошло, с фильтром." />
    case 'help':
    case 'helpPage':
      return (
        <SectionPage
          title="Справка"
          hint="Как пользоваться каждым разделом и что делать при сбое."
        />
      )
    case 'setup':
    case 'login':
      return null
  }
}

export function App() {
  const path = usePath()
  const route = matchRoute(path)
  if (route?.screen === 'setup') return <SetupPage />
  if (route?.screen === 'login') return <LoginPage />
  const shown = route ?? { screen: 'today' as const, params: {} }
  return (
    <Shell route={shown}>
      <Suspense fallback={<Loading />}>
        {route ? <ScreenView route={route} /> : <NotFoundPage />}
      </Suspense>
    </Shell>
  )
}
