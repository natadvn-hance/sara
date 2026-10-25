import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError, api, type DirectionVersionRow, type DirectionView, go } from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'

const STATE: Record<DirectionView['state'], { text: string; dot: string }> = {
  on: { text: 'работает', dot: 'bg-ok' },
  shadow: { text: 'в тени: оценивает, но заявок не получает', dot: 'bg-warn' },
  draft: { text: 'настраивается', dot: 'bg-muted' },
}

const WHEN = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  })

function Version({
  v,
  onRollback,
  busy,
}: {
  v: DirectionVersionRow
  onRollback: (version: number) => void
  busy: boolean
}) {
  const [asking, setAsking] = useState(false)
  // The button that opened the question comes back when it is closed, so the keyboard does not lose its place.
  const trigger = useRef<HTMLButtonElement>(null)
  const wasAsking = useRef(false)
  useEffect(() => {
    if (wasAsking.current && !asking) trigger.current?.focus()
    wasAsking.current = asking
  }, [asking])
  return (
    <li className="grid gap-1 border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="font-medium">{`v${v.version}`}</span>{' '}
        {v.active ? <span className="text-sm text-ok">действует</span> : null}{' '}
        <span className="text-sm text-muted">
          {`${WHEN(v.createdAt)}, ${v.createdBy === 'boris' ? 'Борис' : 'при запуске'}`}
        </span>
      </div>
      <p className="text-sm">{v.reason}</p>
      {v.active ? null : asking ? (
        <div className="grid gap-2">
          <p>{`Вернуть v${v.version}? Старые версии останутся.`}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              autoFocus
              disabled={busy}
              onClick={() => {
                onRollback(v.version)
                setAsking(false)
              }}
            >
              Да, вернуть
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button ref={trigger} variant="secondary" disabled={busy} onClick={() => setAsking(true)}>
            Вернуть эту версию
          </Button>
        </div>
      )}
    </li>
  )
}

export function DirectionPage({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const key = ['direction', accountId]
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<DirectionView>(`/api/directions/${encodeURIComponent(accountId)}`),
    retry: false,
  })
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) go('/login')
  }, [q.error])
  const [said, setSaid] = useState<string | null>(null)
  const rollback = useMutation({
    onMutate: () => setSaid(null),
    mutationFn: (version: number) =>
      api<{ version: number }>(`/api/directions/${encodeURIComponent(accountId)}/rollback`, {
        version,
      }),
    onSuccess: async (r) => {
      setSaid(`Теперь действуют правила v${r.version}`)
      await qc.invalidateQueries({ queryKey: key })
    },
  })

  useEffect(() => {
    if (rollback.error instanceof ApiError && rollback.error.status === 401) go('/login')
  }, [rollback.error])

  const back = (
    <a
      className="text-accent underline"
      href="/accounts"
      onClick={(e) => {
        e.preventDefault()
        go('/accounts')
      }}
    >
      К аккаунтам
    </a>
  )

  if (q.isPending) return <main className="mx-auto max-w-2xl px-4 py-6">Загружаю…</main>
  if (q.error instanceof ApiError && q.error.status === 404)
    return (
      <main className="mx-auto grid max-w-2xl gap-4 px-4 py-6">
        <p>{q.error.message}</p>
        {back}
      </main>
    )
  if (!q.data)
    return (
      <main className="mx-auto grid max-w-2xl justify-items-start gap-4 px-4 py-6">
        <p role="alert">Не получилось загрузить. Попробуй ещё раз.</p>
        <Button onClick={() => q.refetch()}>Повторить</Button>
        {back}
      </main>
    )

  const d = q.data
  const { rules } = d.active
  const state = STATE[d.state]
  return (
    <main className="mx-auto grid max-w-2xl gap-4 px-4 py-6">
      {back}
      <h1 className="font-display text-2xl">{d.account.title}</h1>
      <p className="flex items-center gap-2 text-sm text-muted">
        <span aria-hidden className={`inline-block size-2.5 rounded-full ${state.dot}`} />
        {`Направление ${state.text}`}
      </p>
      {said ? <p role="status">{said}</p> : null}
      {rollback.error ? (
        <p role="alert" className="text-danger">
          {rollback.error.message}
        </p>
      ) : null}

      <Card>
        <h2 className="font-display text-lg">{`Правила v${d.active.version}`}</h2>
        <p>{rules.about}</p>
        <details>
          <summary className="cursor-pointer font-medium">{`Стоп-факторы (${rules.stop_factors.length})`}</summary>
          <ul className="mt-2 grid gap-3">
            {rules.stop_factors.map((s) => (
              <li key={s.id} className="grid gap-1">
                <p>{s.text}</p>
                {s.exception ? (
                  <p className="text-sm text-muted">{`Исключение: ${s.exception}`}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
        <details>
          <summary className="cursor-pointer font-medium">{`Красные флаги (${rules.red_flags.length})`}</summary>
          <ul className="mt-2 grid gap-3">
            {rules.red_flags.map((f) => (
              <li key={f.id}>
                {f.text}
                {f.soft ? <span className="text-sm text-muted">{' (мягкий)'}</span> : null}
              </li>
            ))}
          </ul>
        </details>
        <div className="grid gap-2">
          <h3 className="font-medium">Как оцениваем</h3>
          <ul className="grid gap-2">
            {rules.axes.map((a) => (
              <li key={a.id} className="grid gap-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span>{a.title}</span>
                  <span className="text-sm text-muted">{`вес ${a.weight}`}</span>
                </div>
                <p className="text-sm text-muted">{a.how}</p>
              </li>
            ))}
          </ul>
          <p>{`Порог: ${rules.threshold}`}</p>
        </div>
        {rules.notes.length > 0 ? (
          <details>
            <summary className="cursor-pointer font-medium">{`Уточнения (${rules.notes.length})`}</summary>
            <ul className="mt-2 grid gap-2">
              {rules.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      <div>
        <a
          className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 font-medium text-white hover:opacity-90"
          href={`/accounts/${encodeURIComponent(accountId)}/direction/onboarding`}
          onClick={(e) => {
            e.preventDefault()
            go(`/accounts/${encodeURIComponent(accountId)}/direction/onboarding`)
          }}
        >
          {d.onboarding?.open ? 'Продолжить настройку' : 'Изменить с Claude'}
        </a>
      </div>
      <p>
        <a
          className="text-accent underline"
          href={`/accounts/${encodeURIComponent(accountId)}/direction/calibration`}
          onClick={(e) => {
            e.preventDefault()
            go(`/accounts/${encodeURIComponent(accountId)}/direction/calibration`)
          }}
        >
          Проверить Сару на моих решениях
        </a>
      </p>
      <p>
        <a
          className="text-accent underline"
          href={`/accounts/${encodeURIComponent(accountId)}/direction/recompute`}
          onClick={(e) => {
            e.preventDefault()
            go(`/accounts/${encodeURIComponent(accountId)}/direction/recompute`)
          }}
        >
          Пересчитать на последних 50 заявках
        </a>
      </p>

      <Card>
        <h2 className="font-display text-lg">Отклик и кейсы</h2>
        <p>
          {d.profile.reply_format
            ? `Формат отклика: ${d.profile.reply_format.parts.map((p) => p.title).join(', ')}, до ${d.profile.reply_format.max_chars} знаков.`
            : 'Формат отклика: как сейчас, приветствие, понимание ситуации и один вопрос.'}
        </p>
        <p>
          {d.profile.cases.length === 0
            ? 'Кейсов в библиотеке пока нет.'
            : `Кейсов в библиотеке: ${d.profile.cases.length}.`}
        </p>
        <p>{`Скорость: ${d.profile.speed === 'fast' ? 'быстрая' : 'обычная'}.`}</p>
        <p className="text-sm text-muted">
          Формат, кейсы и скорость правятся в настройке, шаги 5-7: «Править текущее направление».
        </p>
      </Card>

      <Card>
        <h2 className="font-display text-lg">Версии правил</h2>
        <ul aria-label="Версии правил" className="grid">
          {[...d.versions].reverse().map((v) => (
            <Version
              key={v.version}
              v={v}
              busy={rollback.isPending}
              onRollback={(version) => rollback.mutate(version)}
            />
          ))}
        </ul>
      </Card>
    </main>
  )
}
