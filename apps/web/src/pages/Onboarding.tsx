import type { OnbAbout, OnbIdeal, OnbStops } from '@sara/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError, api, go, type OnboardingView } from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { type StepItem, Stepper } from '../components/ui/stepper'
import { Textarea } from '../components/ui/textarea'
import { useAction } from '../hooks'

const TITLES = [
  'Чем занимаемся',
  'Чего не берём',
  'Идеальная заявка',
  'Калибровка',
  'Формат отклика',
  'Кейсы и ссылки',
  'Скорость и деньги',
  'Включение',
]
/** The steps that talk to Claude and are built (the rest say «скоро»). */
const BUILT = [1, 2, 3]

const ASK: Record<number, { hint: string; example: string }> = {
  1: {
    hint: 'Расскажи, чем занимается этот аккаунт: какие услуги, каких клиентов ищешь, с какими бюджетами.',
    example:
      'Мы делаем системный маркетинг для малого бизнеса: стратегия, сайты, воронки. Бюджеты от 50 тысяч.',
  },
  2: {
    hint: 'Чего ты не берёшь? Скажи отдельно, что не берёшь совсем, а что только настораживает.',
    example: 'Не берём только Директ и вакансии в штат. Не нравится, когда ищут самого дешёвого.',
  },
  3: {
    hint: 'Опиши два-три лучших заказа из своего опыта: что в них было хорошего.',
    example:
      'Лучший заказ: клиника хотела разобраться, почему нет записей, бюджет от 100 тысяч, понятная задача.',
  },
}

const path = (accountId: string) => `/api/directions/${encodeURIComponent(accountId)}/onboarding`

type Data<T> = Omit<T, 'understood'>

/** What a reading would record, in words (the «Как это запишется» block). */
function Recorded({ step, data }: { step: number; data: unknown }) {
  if (step === 1) {
    const d = data as Data<OnbAbout>
    return (
      <ul className="grid gap-1 text-sm">
        <li>{`Описание: ${d.about}`}</li>
        <li>{`Услуги: ${d.services.join(', ') || 'не названы'}`}</li>
        <li>{`Клиенты: ${d.clients.join(', ') || 'не названы'}`}</li>
        <li>{`Бюджеты: ${d.budgets.join(', ') || 'не названы'}`}</li>
      </ul>
    )
  }
  if (step === 2) {
    const d = data as Data<OnbStops>
    return (
      <div className="grid gap-2 text-sm">
        <p className="font-medium">Не берём совсем</p>
        <ul className="grid gap-1">
          {d.stop_factors.map((s) => (
            <li key={s.id}>
              {s.text}
              {s.exception ? ` Исключение: ${s.exception}` : ''}
            </li>
          ))}
        </ul>
        <p className="font-medium">Настораживает</p>
        <ul className="grid gap-1">
          {d.red_flags.map((f) => (
            <li key={f.id}>{`${f.text}${f.soft ? ' (мягкий)' : ''}`}</li>
          ))}
        </ul>
      </div>
    )
  }
  const d = data as Data<OnbIdeal>
  return (
    <div className="grid gap-2 text-sm">
      <ul className="grid gap-1">
        {d.axes.map((a) => (
          <li key={a.id}>{`${a.title}, вес ${a.weight}: ${a.how}`}</li>
        ))}
      </ul>
      <p>{`Порог: ${d.threshold}`}</p>
      {d.notes.length > 0 ? <p>{`Уточнения: ${d.notes.join('; ')}`}</p> : null}
    </div>
  )
}

function Error_({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-danger">
      {message}
    </p>
  ) : null
}

function StepCard({
  n,
  view,
  accountId,
  onView,
  onDone,
}: {
  n: number
  view: OnboardingView
  accountId: string
  onView: (v: OnboardingView) => void
  onDone: () => void
}) {
  const st = view.steps[String(n)]
  const [say, setSay] = useState(st?.say ?? '')
  const [fixing, setFixing] = useState(false)
  const [fix, setFix] = useState('')
  const a = useAction()
  const ask = ASK[n]
  const previous = st ? st.attempts.slice(0, -1) : []
  // The card is new for every step: the keyboard starts at its heading instead of falling to the page.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])

  async function send(withFix: boolean) {
    await a.run(async () => {
      const r = await api<{ onboarding: OnboardingView }>(`${path(accountId)}/steps/${n}`, {
        say,
        ...(withFix ? { fix } : {}),
      })
      onView(r.onboarding)
      setFixing(false)
      setFix('')
    })
  }
  async function act(what: 'confirm' | 'skip') {
    await a.run(async () => {
      const r = await api<{ onboarding: OnboardingView }>(
        `${path(accountId)}/steps/${n}/${what}`,
        {},
      )
      onView(r.onboarding)
      onDone()
    })
  }

  return (
    <Card>
      <h2 ref={heading} tabIndex={-1} className="font-display text-lg outline-none">
        {`Шаг ${n}. ${TITLES[n - 1]}`}
      </h2>
      <p>{ask?.hint}</p>
      <Textarea
        label="Расскажи своими словами"
        value={say}
        onChange={(e) => setSay(e.target.value)}
        maxLength={4000}
        placeholder={ask?.example}
      />
      <div className="flex flex-wrap gap-2">
        <Button disabled={a.busy || !say.trim()} onClick={() => send(false)}>
          {st?.proposal ? 'Отправить заново' : 'Отправить'}
        </Button>
        {view.mode === 'edit' ? (
          <Button variant="secondary" disabled={a.busy} onClick={() => act('skip')}>
            Пропустить шаг
          </Button>
        ) : null}
      </div>
      {a.busy ? <p role="status">Думаю…</p> : null}
      <Error_ message={a.error?.message ?? null} />

      {st?.proposal ? (
        <div className="grid gap-3 border-t border-border pt-4">
          <h3 className="font-medium">Я поняла так:</h3>
          <p className="break-words">{st.proposal.understood}</p>
          <details>
            <summary className="cursor-pointer text-sm">Как это запишется</summary>
            <div className="mt-2 break-words">
              <Recorded step={n} data={st.proposal.data} />
            </div>
          </details>
          {previous.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-sm">{`Прошлые попытки (${previous.length})`}</summary>
              <ol className="mt-2 grid gap-2 text-sm">
                {previous.map((p, i) => (
                  // The attempts are only ever appended, so the position is a stable key.
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
                  <li key={i} className="break-words">
                    {p.fix ? <span className="text-muted">{`Поправка: ${p.fix}. `}</span> : null}
                    {p.understood}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          <p className="font-medium">Правильно понимаю?</p>
          {st.confirmed != null ? <p className="text-sm text-ok">Подтверждено</p> : null}
          {fixing ? (
            <div className="grid gap-2">
              <Textarea
                label="Что не так?"
                value={fix}
                onChange={(e) => setFix(e.target.value)}
                maxLength={2000}
                rows={3}
              />
              <div className="flex flex-wrap gap-2">
                <Button disabled={a.busy || !say.trim() || !fix.trim()} onClick={() => send(true)}>
                  Переделать
                </Button>
                <Button variant="secondary" onClick={() => setFixing(false)}>
                  Отмена
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button disabled={a.busy} onClick={() => act('confirm')}>
                Да, правильно
              </Button>
              <Button variant="secondary" disabled={a.busy} onClick={() => setFixing(true)}>
                Нет, поправить
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  )
}

function FinishCard({
  view,
  accountId,
  onView,
  onSaved,
}: {
  view: OnboardingView
  accountId: string
  onView: (v: OnboardingView) => void
  onSaved: (version: number | null) => void
}) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const a = useAction()
  const unchanged = !view.changed

  return (
    <Card>
      <h2 className="font-display text-lg">Черновик правил готов</h2>
      {unchanged ? (
        <p>Пока ничего не изменено.</p>
      ) : (
        <div className="grid gap-1">
          <p className="font-medium">Что изменится:</p>
          <ul className="grid gap-1 text-sm">
            {view.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-sm text-muted">
        Калибровка на настоящих заявках, формат отклика, кейсы, скорость и деньги появятся в
        следующих обновлениях. Сейчас черновик можно сохранить без проверки: напиши, зачем.
      </p>
      {unchanged ? null : (
        <Input
          label="Зачем сохраняешь без проверки?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
        />
      )}
      <a
        className="text-accent underline"
        href={`/accounts/${accountId}/direction/recompute?rules=draft`}
        onClick={(e) => {
          e.preventDefault()
          go(`/accounts/${accountId}/direction/recompute?rules=draft`)
        }}
      >
        Пересчитать на последних 50 заявках
      </a>
      <Error_ message={a.error?.message ?? null} />
      {a.error?.code === 'stale' ? (
        <Button
          variant="secondary"
          disabled={a.busy}
          onClick={() =>
            a.run(async () => {
              const r = await api<{ onboarding: OnboardingView }>(`${path(accountId)}/rebase`, {})
              onView(r.onboarding)
            })
          }
        >
          Обновить черновик
        </Button>
      ) : null}
      <div>
        <Button
          disabled={a.busy || !view.rules || (!unchanged && !reason.trim())}
          onClick={() =>
            a.run(async () => {
              const r = await api<{ version: number | null }>(`${path(accountId)}/finish`, {
                ...(unchanged ? {} : { override: { reason } }),
              })
              // First the saved card, then the refetch that finds the draft closed: no flash of the start card.
              onSaved(r.version)
              await qc.invalidateQueries({ queryKey: ['direction', accountId] })
              await qc.invalidateQueries({ queryKey: ['onboarding', accountId] })
            })
          }
        >
          {unchanged ? 'Закончить настройку' : 'Сохранить без калибровки'}
        </Button>
      </div>
    </Card>
  )
}

function Wizard({
  accountId,
  view,
  onView,
  onSaved,
}: {
  accountId: string
  view: OnboardingView
  onView: (v: OnboardingView) => void
  onSaved: (version: number | null) => void
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const qc = useQueryClient()
  const [asking, setAsking] = useState(false)
  const cancel = useAction()
  const step = selected ?? view.step
  const items: StepItem[] = TITLES.map((title, i) => {
    const n = i + 1
    const st = view.steps[String(n)]
    const done = st?.confirmed != null || st?.skipped
    const built = BUILT.includes(n)
    return {
      n,
      title,
      state:
        n === step ? 'current' : !built ? 'soon' : st?.skipped ? 'skipped' : done ? 'done' : 'todo',
      onOpen: built ? () => setSelected(n) : undefined,
    }
  })
  return (
    <>
      {view.broken ? (
        <Card>
          <p role="alert">Черновик не читается: отмени его и начни настройку заново.</p>
        </Card>
      ) : null}
      {view.broken ? null : <Stepper steps={items} current={Math.min(step, TITLES.length)} />}
      {view.broken ? null : step <= 3 ? (
        <StepCard
          key={step}
          n={step}
          view={view}
          accountId={accountId}
          onView={onView}
          onDone={() => setSelected(null)}
        />
      ) : (
        <FinishCard view={view} accountId={accountId} onView={onView} onSaved={onSaved} />
      )}
      <Error_ message={cancel.error?.message ?? null} />
      {asking ? (
        <div className="grid gap-2">
          <p>Отменить настройку? Черновик пропадёт, правила останутся как есть.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={cancel.busy}
              onClick={() =>
                cancel.run(async () => {
                  await api(`${path(accountId)}/cancel`, {})
                  await qc.invalidateQueries({ queryKey: ['onboarding', accountId] })
                  go(`/accounts/${accountId}/direction`)
                })
              }
            >
              Да, отменить
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Нет, продолжить
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="secondary" onClick={() => setAsking(true)}>
            Отменить настройку
          </Button>
        </div>
      )}
    </>
  )
}

function Start({ accountId, onView }: { accountId: string; onView: (v: OnboardingView) => void }) {
  const a = useAction()
  const start = (mode: 'new' | 'edit') =>
    a.run(async () => {
      const r = await api<{ onboarding: OnboardingView }>(path(accountId), { mode })
      onView(r.onboarding)
    })
  return (
    <Card>
      <h2 className="font-display text-lg">Как настроим?</h2>
      <p>
        Ты рассказываешь словами, Claude раскладывает по полям и спрашивает «Правильно понимаю?».
        Ничего не меняется, пока ты сам не сохранишь правила.
      </p>
      <Error_ message={a.error?.message ?? null} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={a.busy} onClick={() => start('edit')}>
          Править текущее направление
        </Button>
        <Button variant="secondary" disabled={a.busy} onClick={() => start('new')}>
          Начать с нуля
        </Button>
      </div>
      <p className="text-sm text-muted">
        «Править» оставляет всё, о чём ты не скажешь. «С нуля» собирает все разделы заново, старые
        версии при этом остаются в истории.
      </p>
    </Card>
  )
}

export function OnboardingPage({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const key = ['onboarding', accountId]
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<{ onboarding: OnboardingView | null }>(path(accountId)),
    retry: false,
  })
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) go('/login')
  }, [q.error])
  const set = (v: OnboardingView) => qc.setQueryData(key, { onboarding: v })
  // Kept here, not in the wizard: once the rules are saved the draft is closed and the wizard goes away.
  const [saved, setSaved] = useState<number | null | undefined>(undefined)

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
  if (q.isPending) return <main className="mx-auto max-w-2xl px-4 py-6">Загружаю…</main>
  if (q.error instanceof ApiError && q.error.status === 404)
    return (
      <main className="mx-auto grid max-w-2xl gap-4 px-4 py-6">
        <p>{q.error.message}</p>
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
  return (
    <main className="mx-auto grid max-w-2xl gap-4 px-4 py-6">
      {back}
      <h1 className="font-display text-2xl">Настройка направления</h1>
      {saved !== undefined ? (
        <Card>
          <p role="status">
            {saved === null
              ? 'Правила не изменились, новая версия не нужна.'
              : `Правила сохранены: v${saved}`}
          </p>
        </Card>
      ) : q.data.onboarding ? (
        <Wizard accountId={accountId} view={q.data.onboarding} onView={set} onSaved={setSaved} />
      ) : (
        <Start accountId={accountId} onView={set} />
      )}
    </main>
  )
}
