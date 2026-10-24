import { plural } from '@sara/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  ApiError,
  api,
  type DirectionView,
  go,
  type OnboardingView,
  type RecomputeItem,
  type RecomputeResult,
  type RunView,
} from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Progress } from '../components/ui/progress'
import { WhyBox } from '../components/ui/whybox'
import { useAction } from '../hooks'

const DECISION = { show: 'показать', drop: 'отсеять' } as const
const BORIS = { yes: 'ты: взял бы', no: 'ты: не взял бы' } as const
const pct = (x: number) => `${Math.round(x * 100)}%`
const base = (accountId: string) => `/api/directions/${encodeURIComponent(accountId)}`

function Item({ i }: { i: RecomputeItem }) {
  return (
    <li className="grid gap-1 border-t border-border py-3 first:border-t-0">
      <p className="font-medium break-words">{`${i.title}, ${i.city}`}</p>
      <p className="text-sm">{`было ${i.before.score}, ${DECISION[i.before.decision]}`}</p>
      <p className="text-sm">{`стало ${i.after.score}, ${DECISION[i.after.decision]}`}</p>
      {i.boris ? <p className="text-sm text-muted">{BORIS[i.boris]}</p> : null}
      <WhyBox>
        <p>{i.after.reason}</p>
        {i.after.stopFactor ? <p>{`Сработал стоп-фактор: ${i.after.stopFactor}`}</p> : null}
        {i.after.redFlags.length > 0 ? (
          <p>{`Красные флаги: ${i.after.redFlags.join(', ')}`}</p>
        ) : null}
        <ul className="grid gap-0.5">
          {i.after.axes.map((a) => (
            <li key={a.id}>{`${a.id}: ${a.score}, ${a.why}`}</li>
          ))}
        </ul>
      </WhyBox>
    </li>
  )
}

function Result({ r }: { r: RecomputeResult }) {
  const orders = (n: number) => plural(n, ['заявки', 'заявок', 'заявок'])
  return (
    <Card>
      <h2 className="font-display text-lg">Что изменится</h2>
      <p>{`Проверено заявок: ${r.checked}${r.skipped > 0 ? `, не получилось оценить: ${r.skipped}` : ''}`}</p>
      {r.changed === 0 ? (
        <p>Решения не изменились ни у одной заявки.</p>
      ) : (
        <>
          <p>{`Изменилось решение у ${r.changed} ${orders(r.changed)} из ${r.checked}`}</p>
          <p className="text-sm text-muted">{`Перестали бы показываться: ${r.toDrop}. Стали бы показываться: ${r.toShow}.`}</p>
        </>
      )}
      {r.agreementBefore !== null && r.agreementAfter !== null ? (
        <p>{`Совпадение с твоими решениями: было ${pct(r.agreementBefore)}, стало ${pct(r.agreementAfter)} (по ${r.withBoris} ${plural(r.withBoris, ['заявке', 'заявкам', 'заявкам'])})`}</p>
      ) : null}
      {r.items.length > 0 ? (
        <ul aria-label="Заявки, у которых изменилось решение">
          {r.items.map((i) => (
            <Item key={i.leadId} i={i} />
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

export function RecomputePage({ accountId }: { accountId: string }) {
  const direction = useQuery({
    queryKey: ['direction', accountId],
    queryFn: () => api<DirectionView>(base(accountId)),
    retry: false,
  })
  const onboarding = useQuery({
    queryKey: ['onboarding', accountId],
    queryFn: () => api<{ onboarding: OnboardingView | null }>(`${base(accountId)}/onboarding`),
    retry: false,
  })
  const [source, setSource] = useState<string | null>(
    new URLSearchParams(window.location.search).get('rules'),
  )
  const [runId, setRunId] = useState<string | null>(
    new URLSearchParams(window.location.search).get('run'),
  )
  const start = useAction()
  const run = useQuery({
    queryKey: ['run', accountId, runId],
    queryFn: () => api<RunView>(`${base(accountId)}/runs/${runId}`),
    enabled: runId !== null,
    retry: false,
    // While the job goes on it is asked again; a finished or stopped one is not.
    refetchInterval: (q) =>
      q.state.data && ['queued', 'running'].includes(q.state.data.state) ? 2000 : false,
  })
  useEffect(() => {
    for (const q of [direction, onboarding, run])
      if (q.error instanceof ApiError && q.error.status === 401) go('/login')
  }, [direction.error, onboarding.error, run.error, direction, onboarding, run])

  const draft = onboarding.data?.onboarding?.rules ? true : false
  const versions = (direction.data?.versions ?? []).filter((v) => !v.active)
  const options = [
    ...(draft ? [{ value: 'draft', label: 'Черновик настройки' }] : []),
    ...[...versions]
      .reverse()
      .map((v) => ({ value: `v${v.version}`, label: `v${v.version}, ${v.reason}` })),
  ]
  const chosen = options.find((o) => o.value === source)?.value ?? options[0]?.value ?? ''

  const back = (
    <a
      className="text-accent underline"
      href={`/accounts/${accountId}/direction`}
      onClick={(e) => {
        e.preventDefault()
        go(`/accounts/${accountId}/direction`)
      }}
    >
      К направлению
    </a>
  )
  if (direction.isPending || onboarding.isPending)
    return <main className="mx-auto max-w-2xl px-4 py-6">Загружаю…</main>
  if (direction.error instanceof ApiError && direction.error.status === 404)
    return (
      <main className="mx-auto grid max-w-2xl gap-4 px-4 py-6">
        <p>{direction.error.message}</p>
      </main>
    )

  const state = run.data?.state
  return (
    <main className="mx-auto grid max-w-2xl gap-4 px-4 py-6">
      {back}
      <h1 className="font-display text-2xl">Пересчёт на последних заявках</h1>
      <Card>
        <p>
          Сара оценит последние 50 заявок по выбранным правилам и действующим, и покажет, у каких
          заявок решение изменилось бы. Ничего не меняется и никому не уходит.
        </p>
        <div className="grid gap-1">
          <label htmlFor="rules-source" className="text-sm text-muted">
            Какие правила попробовать
          </label>
          <select
            id="rules-source"
            className="min-h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-text"
            value={chosen}
            onChange={(e) => setSource(e.target.value)}
          >
            {options.length === 0 ? <option value="">Нет других правил</option> : null}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {start.error ? (
          <p role="alert" className="text-danger">
            {start.error.message}
          </p>
        ) : null}
        <div>
          <Button
            disabled={start.busy || chosen === '' || state === 'queued' || state === 'running'}
            onClick={() =>
              start.run(async () => {
                const rules = chosen === 'draft' ? 'draft' : { version: Number(chosen.slice(1)) }
                const r = await api<{ id: string }>(`${base(accountId)}/runs`, {
                  kind: 'recompute',
                  rules,
                })
                setRunId(r.id)
                window.history.replaceState(null, '', `?rules=${chosen}&run=${r.id}`)
              })
            }
          >
            Пересчитать на последних 50 заявках
          </Button>
        </div>
      </Card>

      {run.isPending && runId !== null ? <p>Загружаю…</p> : null}
      {run.error && !(run.error instanceof ApiError && run.error.status === 401) ? (
        <p role="alert">Не получилось узнать, как идёт проверка. Обнови страницу.</p>
      ) : null}
      {run.data && (state === 'queued' || state === 'running') ? (
        <Card>
          <h2 className="font-display text-lg">Считаю</h2>
          <Progress done={run.data.done} total={run.data.total} label="Ход проверки" />
        </Card>
      ) : null}
      {state === 'stopped' ? (
        <p role="status">
          {run.data?.stop_reason === 'limit'
            ? 'Подожди, лимит Claude кончился. Попробуй позже.'
            : 'Проверка остановлена. Попробуй ещё раз.'}
        </p>
      ) : null}
      {state === 'failed' ? <p role="alert">Проверка сломалась. Попробуй ещё раз.</p> : null}
      {state === 'done' && run.data?.result ? <Result r={run.data.result} /> : null}
    </main>
  )
}
