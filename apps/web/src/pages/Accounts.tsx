import { formatRub } from '@sara/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { ApiError, api, go } from '../api'
import { Card } from '../components/ui/card'

type Account = {
  id: string
  title: string
  login_state: string
  balance_rub: number | null
  presence: boolean
  egress_ip: string | null
  ip_ok: boolean
}

const STATE: Record<string, string> = {
  alive: 'вход жив',
  dead: 'нужно войти',
  banned: 'профиль заблокирован',
  unknown: 'служба не отвечает',
}

export function AccountsPage() {
  const q = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<{ accounts: Account[] }>('/api/accounts'),
    retry: false,
  })
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) go('/login')
  }, [q.error])
  return (
    <main className="mx-auto grid max-w-xl gap-4 px-4 py-6">
      <h1 className="font-display text-2xl">Аккаунты</h1>
      {!q.data ? <p>Загружаю…</p> : null}
      {q.data?.accounts.map((a) => (
        <Card key={a.id}>
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`inline-block size-2.5 rounded-full ${a.login_state === 'alive' && a.ip_ok ? 'bg-ok' : 'bg-danger'}`}
            />
            <h2 className="font-medium">{a.title}</h2>
            <span className="text-sm text-muted">{STATE[a.login_state] ?? a.login_state}</span>
          </div>
          <p className="text-sm">
            {`Баланс: ${a.balance_rub === null ? 'неизвестен' : formatRub(a.balance_rub)}. IP: ${a.egress_ip ?? 'неизвестен'}${a.egress_ip && !a.ip_ok ? ' (не свой)' : ''}`}
          </p>
          <a
            className="text-accent underline"
            href={`/accounts/${a.id}/login`}
            onClick={(e) => {
              e.preventDefault()
              go(`/accounts/${a.id}/login`)
            }}
          >
            Войти в Профи.ру
          </a>
        </Card>
      ))}
    </main>
  )
}
