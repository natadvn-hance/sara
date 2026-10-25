import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  type Advice,
  ApiError,
  api,
  type CalibrationItem,
  type CalibrationMiss,
  type CalibrationResult,
  type DirectionView,
  go,
  type RunView,
} from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Progress } from '../components/ui/progress'
import { Textarea } from '../components/ui/textarea'
import { WhyBox } from '../components/ui/whybox'
import { useAction } from '../hooks'
import { failedText, pct, stoppedText } from '../runTexts'

const base = (accountId: string) => `/api/directions/${encodeURIComponent(accountId)}`
const MARKS = [
  { mark: 'yes', label: 'Взяли бы', key: '1' },
  { mark: 'no', label: 'Нет', key: '2' },
  { mark: 'unsure', label: 'Не знаю', key: '3' },
] as const

function Marking({
  accountId,
  run,
  onRun,
}: {
  accountId: string
  run: RunView
  onRun: (r: RunView) => void
}) {
  const items = run.calibration?.items ?? []
  const firstOpen = items.findIndex((i) => i.mark === null)
  const [index, setIndex] = useState(firstOpen === -1 ? Math.max(0, items.length - 1) : firstOpen)
  const a = useAction()
  const item: CalibrationItem | undefined = items[index]

  async function mark(m: 'yes' | 'no' | 'unsure') {
    if (!item) return
    await a.run(async () => {
      await api(`${base(accountId)}/runs/${run.id}/marks`, { lead_id: item.leadId, mark: m })
      // The next order, or the screen of the scoring when this was the last mark.
      setIndex((i) => Math.min(i + 1, items.length - 1))
      onRun({
        ...run,
        calibration: run.calibration && {
          ...run.calibration,
          marked: run.calibration.marked + (item.mark === null ? 1 : 0),
          items: items.map((x) => (x.leadId === item.leadId ? { ...x, mark: m } : x)),
        },
      })
    })
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (
        a.busy ||
        (e.target instanceof HTMLElement && /^(TEXTAREA|INPUT)$/.test(e.target.tagName))
      )
        return
      const hit = MARKS.find((m) => m.key === e.key)
      if (hit) void mark(hit.mark)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })

  if (!item) return null
  return (
    <Card>
      <Progress done={run.calibration?.marked ?? 0} total={run.total} label="Отмечено заявок" />
      <h2 className="font-display text-lg break-words">{item.title}</h2>
      <p className="text-sm text-muted">
        {`${item.city}${item.budget ? `, бюджет: ${item.budget}` : ''}`}
      </p>
      <p className="break-words whitespace-pre-line">{item.text}</p>
      <p className="font-medium">Взяли бы такую заявку?</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {MARKS.map((m) => (
          <Button
            key={m.mark}
            variant={item.mark === m.mark ? 'primary' : 'secondary'}
            disabled={a.busy}
            onClick={() => mark(m.mark)}
          >
            {m.label}
          </Button>
        ))}
      </div>
      {item.mark ? (
        <p className="text-sm text-muted">Ты уже отмечал эту заявку, ответ можно поменять.</p>
      ) : null}
      <p className="text-sm text-muted">
        Клавиши 1, 2 и 3 тоже работают. Оценку Сары ты увидишь после последней заявки.
      </p>
      {a.error ? (
        <p role="alert" className="text-danger">
          {a.error.message}
        </p>
      ) : null}
      <div>
        <Button variant="secondary" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
          Назад
        </Button>
      </div>
    </Card>
  )
}

function Miss({
  m,
  titles,
  accountId,
  runId,
}: {
  m: CalibrationMiss
  titles: Map<string, string>
  accountId: string
  runId: string
}) {
  const [note, setNote] = useState(m.note ?? '')
  const [saved, setSaved] = useState(false)
  const a = useAction()
  return (
    <li className="grid gap-2 border-t border-border py-3 first:border-t-0">
      <p className="font-medium break-words">{`${m.title}, ${m.city}`}</p>
      <p className="text-sm">{`Балл Сары: ${m.score}`}</p>
      <details>
        <summary className="min-h-8 cursor-pointer text-sm">Текст заявки</summary>
        <p className="mt-1 text-sm break-words whitespace-pre-line">{m.text}</p>
      </details>
      <WhyBox>
        <p>{m.reason}</p>
        {m.stopFactor ? <p>{`Сработал стоп-фактор: ${m.stopFactor}`}</p> : null}
        {m.redFlags.length > 0 ? <p>{`Красные флаги: ${m.redFlags.join(', ')}`}</p> : null}
        <ul className="grid gap-0.5">
          {m.axes.map((x) => (
            <li key={x.id}>{`${titles.get(x.id) ?? x.id}: ${x.score}, ${x.why}`}</li>
          ))}
        </ul>
      </WhyBox>
      <Textarea
        label="Почему ты так решил? (необязательно)"
        value={note}
        rows={2}
        maxLength={1000}
        onChange={(e) => {
          setNote(e.target.value)
          setSaved(false)
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={a.busy || !note.trim() || saved}
          onClick={() =>
            a.run(async () => {
              await api(`${base(accountId)}/runs/${runId}/notes`, { lead_id: m.leadId, note })
              setSaved(true)
            })
          }
        >
          Записать причину
        </Button>
        {saved ? (
          <span role="status" className="text-sm text-ok">
            Записано
          </span>
        ) : null}
      </div>
      {a.error ? (
        <p role="alert" className="text-danger">
          {a.error.message}
        </p>
      ) : null}
    </li>
  )
}

function Result({
  accountId,
  run,
  r,
  titles,
  onRun,
}: {
  accountId: string
  run: RunView
  r: CalibrationResult
  titles: Map<string, string>
  onRun: (id: string) => void
}) {
  const [advice, setAdvice] = useState<Advice | null>(run.calibration?.advice ?? null)
  const a = useAction()
  const lost = r.misses.filter((m) => m.kind === 'sara_no_boris_yes')
  const extra = r.misses.filter((m) => m.kind === 'sara_yes_boris_no')
  const apply = (source: 'advice' | 'threshold') =>
    a.run(async () => {
      const x = await api<{ id: string }>(`${base(accountId)}/runs/${run.id}/apply`, { source })
      onRun(x.id)
    })
  return (
    <>
      <Card>
        <h2 className="font-display text-lg">Что вышло</h2>
        <p>
          {r.agreement === null
            ? 'Ни одной заявки с ответом «да» или «нет».'
            : `Согласие: ${pct(r.agreement)} (${Math.round(r.agreement * r.decisive)} из ${r.decisive})`}
        </p>
        {r.unsure > 0 ? (
          <p className="text-sm text-muted">{`«Не знаю»: ${r.unsure}, они не считаются.`}</p>
        ) : null}
        {!r.reliable ? (
          <p role="alert">
            Слишком много «не знаю»: ответов «да» и «нет» всего {r.decisive}, нужно не меньше 15.
            Проверка ненадёжна, цель не засчитана.
          </p>
        ) : r.passed ? (
          <p className="text-ok">Цель 85% достигнута, Сару можно включать на этих правилах.</p>
        ) : (
          <p>Цель 85% не достигнута. Посмотри расхождения ниже и поправь правила.</p>
        )}
        {run.calibration?.stale ? (
          <div className="grid gap-2">
            <p role="alert">Правила изменились после этой проверки.</p>
            <div>
              <Button
                disabled={a.busy}
                onClick={() =>
                  a.run(async () => {
                    const x = await api<{ id: string }>(
                      `${base(accountId)}/runs/${run.id}/recalibrate`,
                      {},
                    )
                    onRun(x.id)
                  })
                }
              >
                Проверить заново на тех же заявках
              </Button>
            </div>
          </div>
        ) : null}
        {a.error ? (
          <p role="alert" className="text-danger">
            {a.error.message}
          </p>
        ) : null}
      </Card>

      {r.thresholdHint ? (
        <Card>
          <h2 className="font-display text-lg">Подсказка про порог</h2>
          <p>{`Порог ${r.thresholdHint.from} → ${r.thresholdHint.to}: согласие было ${pct(r.thresholdHint.before)}, стало бы ${pct(r.thresholdHint.after)}.`}</p>
          <div>
            <Button disabled={a.busy} onClick={() => apply('threshold')}>
              Применить к черновику
            </Button>
          </div>
        </Card>
      ) : null}

      {r.misses.length > 0 ? (
        <Card>
          <h2 className="font-display text-lg">Где Сара и ты разошлись</h2>
          {lost.length > 0 ? (
            <>
              <h3 className="font-medium">Сара отсеяла, а ты взял бы</h3>
              <ul aria-label="Заявки, которые Сара отсеяла, а ты взял бы">
                {lost.map((m) => (
                  <Miss key={m.leadId} m={m} titles={titles} accountId={accountId} runId={run.id} />
                ))}
              </ul>
            </>
          ) : null}
          {extra.length > 0 ? (
            <>
              <h3 className="font-medium">Сара показала бы, а ты нет</h3>
              <ul aria-label="Заявки, которые Сара показала бы, а ты нет">
                {extra.map((m) => (
                  <Miss key={m.leadId} m={m} titles={titles} accountId={accountId} runId={run.id} />
                ))}
              </ul>
            </>
          ) : null}
          <div className="grid gap-2">
            <div>
              <Button
                variant="secondary"
                disabled={a.busy}
                onClick={() =>
                  a.run(async () => {
                    const x = await api<{ advice: Advice }>(
                      `${base(accountId)}/runs/${run.id}/advice`,
                      {},
                    )
                    setAdvice(x.advice)
                  })
                }
              >
                Предложить поправку
              </Button>
            </div>
            {a.busy ? <p role="status">Думаю…</p> : null}
          </div>
          {advice ? (
            <div className="grid gap-2 border-t border-border pt-3">
              <h3 className="font-medium">Предлагаю поправку</h3>
              <p>{advice.summary}</p>
              <p className="text-sm text-muted">{`Почему: ${advice.why}`}</p>
              <ul className="grid gap-1 text-sm">
                {advice.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="text-sm text-muted">
                После «Применить» Сара пересчитает те же заявки по новым правилам, отмечать заново
                не надо.
              </p>
              <div>
                <Button disabled={a.busy} onClick={() => apply('advice')}>
                  Применить к черновику
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}
    </>
  )
}

export function CalibrationPage({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const params = new URLSearchParams(window.location.search)
  const [source] = useState(params.get('rules') === 'draft' ? 'draft' : 'active')
  const [runId, setRunId] = useState<string | null>(params.get('run'))
  const [gone, setGone] = useState(false)
  const start = useAction()
  const direction = useQuery({
    queryKey: ['direction', accountId],
    queryFn: () => api<DirectionView>(base(accountId)),
    retry: false,
  })
  const run = useQuery({
    queryKey: ['run', accountId, runId],
    queryFn: () => api<RunView>(`${base(accountId)}/runs/${runId}`),
    enabled: runId !== null,
    retry: false,
    refetchInterval: (q) =>
      q.state.data && ['queued', 'running'].includes(q.state.data.state) ? 2000 : false,
  })
  const open = (id: string | null) => {
    setRunId(id)
    window.history.replaceState(
      null,
      '',
      id ? `?rules=${source}&run=${id}` : window.location.pathname,
    )
  }
  useEffect(() => {
    if (run.error instanceof ApiError && run.error.status === 404) {
      setGone(true)
      setRunId(null)
      window.history.replaceState(null, '', window.location.pathname)
    }
    for (const q of [direction, run])
      if (q.error instanceof ApiError && q.error.status === 401) go('/login')
  }, [run.error, direction.error, direction, run])

  const titles = new Map((direction.data?.active.rules.axes ?? []).map((x) => [x.id, x.title]))
  const link = (to: string, text: string) => (
    <a
      className="text-accent underline"
      href={to}
      onClick={(e) => {
        e.preventDefault()
        go(to)
      }}
    >
      {text}
    </a>
  )
  const setRun = (r: RunView) => {
    qc.setQueryData(['run', accountId, runId], r)
    // The last mark sends the run to scoring: ask the core how it goes instead of waiting for the next poll.
    if (r.calibration?.items.every((i) => i.mark !== null))
      void qc.invalidateQueries({ queryKey: ['run', accountId, runId] })
  }
  const state = run.data?.state

  return (
    <main className="mx-auto grid max-w-2xl gap-4 px-4 py-6">
      <nav className="flex flex-wrap gap-x-4 gap-y-1">
        {link(`/accounts/${accountId}/direction`, 'К направлению')}
        {link(`/accounts/${accountId}/direction/onboarding`, 'К настройке')}
      </nav>
      <h1 className="font-display text-2xl">Проверка Сары на моих решениях</h1>
      {runId === null ? (
        <Card>
          <p>
            Я покажу тебе 20 настоящих заявок из ленты, по одной. Отметь, взяли бы ты такую, или
            нет. Мою оценку ты увидишь после последней заявки, чтобы она не подсказывала. Потом
            сравним, сколько решений совпало, цель 85%.
          </p>
          <p className="text-sm text-muted">
            {source === 'draft'
              ? 'Проверяю черновик правил из настройки.'
              : 'Проверяю действующие правила.'}
          </p>
          {gone ? <p role="alert">Такой проверки нет.</p> : null}
          {start.error ? (
            <p role="alert" className="text-danger">
              {start.error.message}
            </p>
          ) : null}
          <div>
            <Button
              disabled={start.busy}
              onClick={() =>
                start.run(async () => {
                  setGone(false)
                  const x = await api<{ id: string }>(`${base(accountId)}/runs`, {
                    kind: 'calibration',
                    rules: source,
                  })
                  open(x.id)
                })
              }
            >
              Начать проверку
            </Button>
          </div>
        </Card>
      ) : null}

      {run.isPending && runId !== null ? <p>Загружаю…</p> : null}
      {run.error && !(run.error instanceof ApiError && [401, 404].includes(run.error.status)) ? (
        <p role="alert">Не получилось узнать, как идёт проверка. Обнови страницу.</p>
      ) : null}
      {run.data && state === 'marking' ? (
        <Marking key={run.data.id} accountId={accountId} run={run.data} onRun={setRun} />
      ) : null}
      {run.data && (state === 'queued' || state === 'running') ? (
        <Card>
          <h2 className="font-display text-lg">Считаю</h2>
          <p className="text-sm text-muted">
            Сара оценивает эти заявки по правилам. Страницу можно не закрывать.
          </p>
          <Progress done={run.data.done} total={run.data.total} label="Ход проверки" />
        </Card>
      ) : null}
      {state === 'stopped' ? (
        <p role="status">{stoppedText(run.data?.stop_reason ?? null)}</p>
      ) : null}
      {state === 'failed' ? <p role="alert">{failedText(run.data?.stop_reason ?? null)}</p> : null}
      {state === 'done' && run.data?.calibration?.result ? (
        <Result
          key={run.data.id}
          accountId={accountId}
          run={run.data}
          r={run.data.calibration.result}
          titles={titles}
          onRun={open}
        />
      ) : null}
    </main>
  )
}
