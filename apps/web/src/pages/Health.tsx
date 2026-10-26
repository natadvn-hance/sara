import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { ApiError, api, go, type HealthCheck } from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'

export function HealthPage() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ checks: HealthCheck[] }>('/api/health'),
    retry: false,
  })
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) go('/login')
  }, [q.error])
  return (
    <main className="mx-auto grid max-w-xl gap-4 px-4 py-6">
      <h1 className="font-display text-2xl">Состояние системы</h1>
      <a
        href="/accounts"
        className="font-medium text-accent underline-offset-4 hover:underline"
        onClick={(e) => {
          e.preventDefault()
          go('/accounts')
        }}
      >
        Аккаунты и какие заказы отбирать
      </a>
      {!q.data ? <p>Проверяю…</p> : null}
      {q.data?.checks.map((c) => (
        <Card key={c.id}>
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`inline-block size-2.5 rounded-full ${c.ok ? 'bg-ok' : 'bg-danger'}`}
            />
            <h2 className="font-medium">{c.title}</h2>
            <span className="text-sm text-muted">{c.ok ? 'работает' : 'не работает'}</span>
          </div>
          <p>{c.detail}</p>
          {c.fix ? <p className="text-sm text-muted">{`Что сделать: ${c.fix}`}</p> : null}
        </Card>
      ))}
      <Button
        variant="secondary"
        onClick={async () => {
          await api('/api/health/claude', {}).catch(() => {})
          await qc.invalidateQueries({ queryKey: ['health'] })
        }}
      >
        Проверить снова
      </Button>
    </main>
  )
}
