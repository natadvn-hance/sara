import { SECTIONS } from '@sara/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api, go, type SetupState } from '../api'
import { insideTelegram } from '../app/telegram'
import { Group, Link, Row } from '../components/list'
import { Page } from '../components/page'
import { Empty } from '../components/states'

/** A section whose screen comes in a later part of M7: its place in the menu already works. */
export function SectionPage({ title, hint }: { title: string; hint: string }) {
  return (
    <Page title={title}>
      <Empty title="Раздел появится в следующих обновлениях" hint={hint} />
    </Page>
  )
}

/** Today (FR-UI-1, JS-8). Until the wizard is done, the pult starts with it. */
export function TodayPage() {
  const setup = useQuery({
    queryKey: ['setup'],
    queryFn: () => api<SetupState>('/api/setup'),
    retry: false,
  })
  // Without a password there is no pult yet; a later unfinished step only gets a line with the way back.
  useEffect(() => {
    if (setup.data?.next === 'password') go('/setup')
  }, [setup.data])
  return (
    <Page title="Сегодня">
      {setup.data && setup.data.next !== 'done' ? (
        <p role="status" className="rounded-lg border border-warn px-4 py-3">
          {'Мастер запуска не закончен. '}
          <Link href="/setup" className="text-accent underline">
            Продолжить
          </Link>
        </p>
      ) : null}
      <Empty
        title="Здесь будет день за 10 секунд"
        hint="Что ждёт тебя, кошелёк и итоги за неделю появятся в следующем обновлении."
      >
        <p>
          <Link href="/health" className="text-accent underline">
            Состояние системы
          </Link>
        </p>
      </Empty>
    </Page>
  )
}

/** Settings. On a narrow screen and in the Mini App they also list the sections that are not tabs. */
export function SettingsPage() {
  const others = SECTIONS.filter((s) => !s.inTabs)
  return (
    <Page title="Настройки">
      <Empty title="Паузы, деньги и лимиты появятся здесь в следующем обновлении" />
      <div className={insideTelegram() ? '' : 'lg:hidden'}>
        <Group title="Разделы">
          {others.map((s) => (
            <Row key={s.id} title={s.title} href={s.path} right="›" />
          ))}
        </Group>
      </div>
    </Page>
  )
}

export function NotFoundPage() {
  return (
    <Page title="Такой страницы нет">
      <p>
        <Link href="/" className="text-accent underline">
          На «Сегодня»
        </Link>
      </p>
    </Page>
  )
}
