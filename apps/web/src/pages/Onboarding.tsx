import type { OnbAbout, OnbCases, OnbIdeal, OnbStops, ReplyFormat } from '@sara/shared'
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
/** Every step is built; the list stays so a step can be hidden again without touching the stepper. */
const BUILT = [1, 2, 3, 4, 5, 6, 7, 8]

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
  5: {
    hint: 'Как должен выглядеть отклик: из каких частей, каким тоном, какой длины. Сара напишет три образца на настоящих заявках, ты их поправишь.',
    example: 'Две части: понимание ситуации и один вопрос. До 400 знаков, спокойно, без клише.',
  },
  6: {
    hint: 'Пришли ссылки на кейсы и скажи, когда какой показывать. Ссылки в отклик вставляет программа, только из этого списка.',
    example:
      'Сайт клиники https://hance.ru/cases/clinic: показывай, когда нужен сайт услуг с записью.',
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
  if (step === 5) {
    const d = data as { reply_format: ReplyFormat }
    const f = d.reply_format
    return (
      <ul className="grid gap-1 text-sm">
        <li>{`Части: ${f.parts.map((p) => p.title).join(', ')}`}</li>
        <li>{`До ${f.max_chars} знаков`}</li>
        <li>{`Тон: ${f.tone.join('; ') || 'не задан'}`}</li>
        <li>{`Кейсов в одном отклике: ${f.max_cases}`}</li>
      </ul>
    )
  }
  if (step === 6) {
    const d = data as Data<OnbCases>
    return d.cases.length === 0 ? (
      <p className="text-sm">Кейсов нет.</p>
    ) : (
      <ul className="grid gap-2 text-sm">
        {d.cases.map((c) => (
          <li key={c.id} className="break-words">
            <span className="font-medium">{c.title}</span>
            {` ${c.url}. ${c.summary} Показывать, когда: ${c.show_when}.`}
            {c.never_when ? ` Не показывать, когда: ${c.never_when}.` : ''}
          </li>
        ))}
      </ul>
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

type Sample = { lead_id: string; greeting: string; body: string }

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
  // Step 5: Boris's edits of the sample bids by lead; what he did not touch goes as proposed.
  const [edits, setEdits] = useState<Record<string, string>>({})
  const a = useAction()
  const ask = ASK[n]
  const samples =
    n === 5 ? ((st?.proposal?.data as { samples?: Sample[] } | undefined)?.samples ?? []) : []
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
      setEdits({})
    })
  }
  async function act(what: 'confirm' | 'skip') {
    await a.run(async () => {
      const body =
        n === 5 && what === 'confirm'
          ? {
              samples: samples.map((x) => ({
                lead_id: x.lead_id,
                body: edits[x.lead_id] ?? x.body,
              })),
            }
          : {}
      const r = await api<{ onboarding: OnboardingView }>(
        `${path(accountId)}/steps/${n}/${what}`,
        body,
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
        {view.mode === 'edit' || n >= 5 ? (
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
          {samples.length > 0 ? (
            <div className="grid gap-3">
              <h3 className="font-medium">Образцы на настоящих заявках</h3>
              <p className="text-sm text-muted">
                Приветствие ставит программа. Поправь текст, как написал бы ты сам: без имени
                клиента, оно в образцы не попадает.
              </p>
              {samples.map((x, i) => (
                <div key={x.lead_id} className="grid gap-1">
                  <p className="text-sm text-muted">{`Образец ${i + 1}. Начнётся с: ${x.greeting}`}</p>
                  <Textarea
                    label={`Текст образца ${i + 1}`}
                    value={edits[x.lead_id] ?? x.body}
                    onChange={(e) => setEdits({ ...edits, [x.lead_id]: e.target.value })}
                    maxLength={2000}
                    rows={4}
                  />
                </div>
              ))}
            </div>
          ) : null}
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

const SPEEDS = [
  {
    id: 'normal',
    title: 'Обычная',
    hint: 'Заявка приходит без спешки, отклик уходит по расписанию.',
  },
  {
    id: 'fast',
    title: 'Быстрая',
    hint: 'Заявка приходит со звуком, отклик уходит сразу: так выше шанс быть первой.',
  },
] as const

function SpeedStep({
  view,
  accountId,
  onView,
  onDone,
}: {
  view: OnboardingView
  accountId: string
  onView: (v: OnboardingView) => void
  onDone: () => void
}) {
  const a = useAction()
  const [speed, setSpeed] = useState<'normal' | 'fast'>(view.profile.speed)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  const save = (chosen: 'normal' | 'fast', leave: boolean) =>
    a.run(async () => {
      const r = await api<{ onboarding: OnboardingView }>(`${path(accountId)}/steps/7/confirm`, {
        speed: chosen,
      })
      onView(r.onboarding)
      setSpeed(chosen)
      if (leave) onDone()
    })
  return (
    <Card>
      <h2 ref={heading} tabIndex={-1} className="font-display text-lg outline-none">
        {`Шаг 7. ${TITLES[6]}`}
      </h2>
      <p>
        Скорость отклика. Деньги (бюджет на день, потолок цены отклика) настраиваются в «Деньги»,
        здесь Сара только сверяет их со скоростью.
      </p>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm text-muted">Скорость</legend>
        {SPEEDS.map((x) => (
          <label key={x.id} className="flex min-h-11 items-start gap-3">
            <input
              type="radio"
              name="speed"
              className="mt-1"
              checked={speed === x.id}
              onChange={() => setSpeed(x.id)}
            />
            <span>
              <span className="font-medium">{x.title}</span>
              <span className="block text-sm text-muted">{x.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {view.contradictions.length > 0 ? (
        <div className="grid gap-2 border-t border-border pt-4">
          <h3 className="font-medium">Что не сходится</h3>
          <ul className="grid gap-2 text-sm">
            {view.contradictions.map((c) => (
              <li key={c.id} className="break-words">
                {c.text}
                {c.fix?.patch.speed ? (
                  <Button
                    variant="secondary"
                    className="ml-2"
                    disabled={a.busy}
                    onClick={() => save(c.fix?.patch.speed ?? 'normal', false)}
                  >
                    {c.fix.label}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Error_ message={a.error?.message ?? null} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={a.busy} onClick={() => save(speed, true)}>
          Да, так
        </Button>
        <Button
          variant="secondary"
          disabled={a.busy}
          onClick={() =>
            a.run(async () => {
              const r = await api<{ onboarding: OnboardingView }>(
                `${path(accountId)}/steps/7/skip`,
                {},
              )
              onView(r.onboarding)
              onDone()
            })
          }
        >
          Оставить как есть
        </Button>
      </div>
    </Card>
  )
}

function CalibrationStep({
  accountId,
  view,
  onNext,
}: {
  accountId: string
  view: OnboardingView
  onNext: (step: number) => void
}) {
  const c = view.calibration
  const to = `/accounts/${accountId}/direction/calibration?rules=draft${c ? `&run=${c.runId}` : ''}`
  return (
    <Card>
      <h2 className="font-display text-lg">Шаг 4. Калибровка</h2>
      <p>
        Сара покажет 20 настоящих заявок, ты отметишь, какие взял бы. Потом сравним с её оценкой по
        этим правилам. Цель: согласие от 85%.
      </p>
      {!c ? (
        <p>На этих правилах Сару ещё не проверяли.</p>
      ) : c.state === 'marking' ? (
        <p>Проверка начата, ждёт твоих отметок.</p>
      ) : c.state === 'stopped' ? (
        <p>
          Проверка остановилась (лимит Claude или нет токена). Открой её и посчитай заново, отметки
          сохранены.
        </p>
      ) : c.state === 'failed' ? (
        <p role="alert">Проверка не получилась. Открой её и посчитай заново, отметки сохранены.</p>
      ) : c.state !== 'done' ? (
        <p role="status">Сара считает, подожди.</p>
      ) : c.agreement === null ? (
        <p>Проверка закончилась без ответов «да» и «нет».</p>
      ) : (
        <p className={c.passed ? 'text-ok' : undefined}>
          {`Согласие на этих правилах: ${Math.round(c.agreement * 100)}%. ${c.passed ? 'Цель достигнута.' : c.reliable ? 'Цель не достигнута.' : 'Ответов «да» и «нет» мало, проверка ненадёжна.'}`}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <a
          className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 font-medium text-white hover:opacity-90"
          href={to}
          onClick={(e) => {
            e.preventDefault()
            go(to)
          }}
        >
          {!c
            ? 'Проверить Сару на моих решениях'
            : c.state === 'done'
              ? 'Открыть результат'
              : 'Продолжить проверку'}
        </a>
        <Button variant="secondary" onClick={() => onNext(5)}>
          К формату отклика
        </Button>
        <Button variant="secondary" onClick={() => onNext(8)}>
          К включению
        </Button>
      </div>
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
  onSaved: (version: number | null, profile: boolean) => void
}) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const a = useAction()
  const unchanged = !view.changed
  const profileChanged = view.profileChanges.length > 0
  const c = view.calibration
  // What the core's gate sees, not the latest run's own verdict: a repeat still being scored does not hide it.
  const passed = view.gatePassed
  const asking = view.directionState === 'draft'
  // A direction that is still a draft is turned on only after a calibration or with a reason, even with rules
  // that changed nothing.
  const gated = !unchanged || asking

  const save = (state?: 'on' | 'shadow') =>
    a.run(async () => {
      const r = await api<{ version: number | null }>(`${path(accountId)}/finish`, {
        ...(!gated || passed ? {} : { override: { reason } }),
        ...(state ? { state } : {}),
      })
      // First the saved card, then the refetch that finds the draft closed: no flash of the start card.
      onSaved(r.version, view.profileChanges.length > 0)
      await qc.invalidateQueries({ queryKey: ['direction', accountId] })
      await qc.invalidateQueries({ queryKey: ['onboarding', accountId] })
    })
  const needsReason = gated && !passed
  const blocked = a.busy || !view.rules || (needsReason && !reason.trim())
  const all =
    c?.agreement != null ? ` (согласие ${Math.round(c.agreement * 100)}%)` : ' (без проверки)'

  return (
    <Card>
      <h2 className="font-display text-lg">Шаг 8. Включение</h2>
      {unchanged && !profileChanged ? (
        <p>Пока ничего не изменено.</p>
      ) : (
        <div className="grid gap-1">
          <p className="font-medium">Что изменится:</p>
          <ul className="grid gap-1 text-sm">
            {[...view.changes, ...view.profileChanges].map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {view.contradictions.length > 0 ? (
        <div className="grid gap-1">
          <p className="font-medium">Стоит проверить:</p>
          <ul className="grid gap-1 text-sm">
            {view.contradictions.map((x) => (
              <li key={x.id} className="break-words">
                {x.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!gated ? null : passed ? (
        <p className="text-ok">{`Калибровка на этих правилах: согласие ${Math.round((c?.agreement ?? 0) * 100)}%, цель достигнута.`}</p>
      ) : (
        <>
          <p role="status">
            {c?.agreement != null
              ? `Калибровка на этих правилах: согласие ${Math.round(c.agreement * 100)}%, цель 85% не достигнута.`
              : 'Калибровки на этих правилах ещё не было.'}
          </p>
          <p className="text-sm text-muted">
            Сохранить правила можно и так, но осознанно: напиши, зачем. Это останется в истории.
          </p>
          <Input
            label="Зачем сохраняешь без проверки?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
          />
        </>
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
      <div className="flex flex-wrap gap-2">
        {asking ? (
          <>
            <Button disabled={blocked} onClick={() => save('on')}>
              {needsReason ? `Включить всё равно${all}` : 'Включить'}
            </Button>
            <Button variant="secondary" disabled={blocked} onClick={() => save('shadow')}>
              Включить в тени
            </Button>
          </>
        ) : (
          <Button disabled={blocked} onClick={() => save()}>
            {unchanged && !needsReason
              ? profileChanged
                ? 'Сохранить отклик, кейсы и скорость'
                : 'Закончить настройку'
              : needsReason
                ? `Сохранить всё равно${all}`
                : 'Сохранить правила'}
          </Button>
        )}
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
  onSaved: (version: number | null, profile: boolean) => void
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
      ) : step === 4 ? (
        <CalibrationStep accountId={accountId} view={view} onNext={setSelected} />
      ) : step === 5 || step === 6 ? (
        <StepCard
          key={step}
          n={step}
          view={view}
          accountId={accountId}
          onView={onView}
          onDone={() => setSelected(step + 1)}
        />
      ) : step === 7 ? (
        <SpeedStep
          key={step}
          view={view}
          accountId={accountId}
          onView={onView}
          onDone={() => setSelected(8)}
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
  const [saved, setSaved] = useState<{ version: number | null; profile: boolean } | undefined>(
    undefined,
  )

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
            {saved.version === null
              ? `Правила не изменились, новая версия не нужна.${saved.profile ? ' Отклик, кейсы и скорость сохранены.' : ''}`
              : `Правила сохранены: v${saved.version}.${saved.profile ? ' Отклик, кейсы и скорость тоже.' : ''}`}
          </p>
        </Card>
      ) : q.data.onboarding ? (
        <Wizard
          accountId={accountId}
          view={q.data.onboarding}
          onView={set}
          onSaved={(version, profile) => setSaved({ version, profile })}
        />
      ) : (
        <Start accountId={accountId} onView={set} />
      )}
    </main>
  )
}
