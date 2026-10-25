import type { Availability, Window } from '@sara/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError, type AvailabilityView, api, go } from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { useAction } from '../hooks'

type Day = keyof Availability['week']
const DAYS: { id: Day; title: string }[] = [
  { id: 'mon', title: 'Понедельник' },
  { id: 'tue', title: 'Вторник' },
  { id: 'wed', title: 'Среда' },
  { id: 'thu', title: 'Четверг' },
  { id: 'fri', title: 'Пятница' },
  { id: 'sat', title: 'Суббота' },
  { id: 'sun', title: 'Воскресенье' },
]
const NUMBERS: {
  key: 'slot_min' | 'buffer_min' | 'max_per_day' | 'notice_h' | 'horizon_days'
  label: string
  min: number
  max: number
}[] = [
  { key: 'slot_min', label: 'Длительность созвона, минут', min: 15, max: 120 },
  { key: 'buffer_min', label: 'Зазор между встречами, минут', min: 0, max: 60 },
  { key: 'max_per_day', label: 'Не больше встреч в день', min: 1, max: 10 },
  { key: 'notice_h', label: 'Не раньше чем через, часов', min: 0, max: 72 },
  { key: 'horizon_days', label: 'Предлагать на дней вперёд', min: 1, max: 21 },
]
/** A new window starts where the last one ends (an hour later at most until 23:59), so it is valid at once. */
function nextWindow(windows: Window[]): Window {
  const last = [...windows].sort((a, b) => a.from.localeCompare(b.from)).at(-1)
  if (!last) return { from: '10:00', to: '13:00' }
  const [h, m] = last.to.split(':').map(Number) as [number, number]
  const end = Math.min(h * 60 + m + 60, 23 * 60 + 59)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { from: last.to, to: `${pad(Math.floor(end / 60))}:${pad(end % 60)}` }
}
const DAY_LABEL = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  })
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })

function Windows({
  name,
  windows,
  onChange,
}: {
  name: string
  windows: Window[]
  onChange: (w: Window[]) => void
}) {
  return (
    <div className="grid gap-2">
      {windows.length === 0 ? <p className="text-sm text-muted">Выходной</p> : null}
      {windows.map((w, i) => (
        // Windows have no id of their own: their place in the day is their identity while editing.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <Input
            id={`${name}-${i}-from`}
            label="с"
            type="time"
            value={w.from}
            onChange={(e) =>
              onChange(windows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))
            }
          />
          <Input
            id={`${name}-${i}-to`}
            label="до"
            type="time"
            value={w.to}
            onChange={(e) =>
              onChange(windows.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))
            }
          />
          <Button
            variant="secondary"
            aria-label={`Убрать окно ${w.from}-${w.to}`}
            onClick={() => onChange(windows.filter((_, j) => j !== i))}
          >
            Убрать
          </Button>
        </div>
      ))}
      {windows.length < 4 ? (
        <Button
          variant="secondary"
          className="justify-self-start"
          onClick={() => onChange([...windows, nextWindow(windows)])}
        >
          + окно
        </Button>
      ) : null}
    </div>
  )
}

/** Boris's free time for calls (FR-MEET-1, design 5.1): days with windows, numbers, days off. */
export function AvailabilityPage() {
  const q = useQuery({
    queryKey: ['availability'],
    queryFn: () => api<AvailabilityView>('/api/meetings/availability'),
    retry: false,
    // A background refetch must not wipe what Boris is typing.
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) go('/login')
  }, [q.error])
  // The draft exists only once Boris edits; until then the page shows what the server has.
  const [edited, setEdited] = useState<Availability | null>(null)
  const [savedView, setSavedView] = useState<AvailabilityView | null>(null)
  const [saved, setSaved] = useState(false)
  const [exceptionDate, setExceptionDate] = useState('')
  const save = useAction()

  if (q.isLoading) return <p className="p-4">Загружаю…</p>
  const view = savedView ?? q.data
  const draft = edited ?? view?.availability
  if (!view || !draft)
    return (
      <main className="mx-auto grid max-w-2xl gap-4 p-4">
        <p role="alert">Не получилось загрузить. Попробуй ещё раз.</p>
        <Button className="justify-self-start" onClick={() => q.refetch()}>
          Повторить
        </Button>
      </main>
    )

  const set = (patch: Partial<Availability>) => {
    setSaved(false)
    save.clear()
    setEdited({ ...draft, ...patch })
  }
  const submit = () =>
    save.run(async () => {
      const r = await api<AvailabilityView>('/api/meetings/availability', draft)
      setEdited(null)
      setSavedView(r)
      setSaved(true)
    })

  return (
    <main className="mx-auto grid max-w-2xl gap-4 p-4">
      <h1 className="font-display text-2xl">Свободное время для созвонов</h1>
      <p className="text-sm text-muted">
        Время московское. Сара предлагает клиентам только это время и не больше встреч в день, чем
        указано.
      </p>
      <Card>
        <h2 className="font-display text-lg">Дни недели</h2>
        {DAYS.map((d) => (
          <fieldset
            key={d.id}
            className="grid gap-2 border-t border-border pt-3 first-of-type:border-t-0"
          >
            <legend className="font-medium">{d.title}</legend>
            <Windows
              name={d.id}
              windows={draft.week[d.id]}
              onChange={(w) => set({ week: { ...draft.week, [d.id]: w } })}
            />
          </fieldset>
        ))}
      </Card>
      <Card>
        <h2 className="font-display text-lg">Правила</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {NUMBERS.map((n) => (
            <Input
              key={n.key}
              id={n.key}
              label={n.label}
              type="number"
              inputMode="numeric"
              min={n.min}
              max={n.max}
              value={draft[n.key]}
              onChange={(e) => set({ [n.key]: Number(e.target.value) })}
            />
          ))}
        </div>
      </Card>
      <Card>
        <h2 className="font-display text-lg">Особые дни</h2>
        {draft.exceptions.length === 0 ? (
          <p className="text-sm text-muted">Особых дней нет.</p>
        ) : null}
        {draft.exceptions.map((x, i) => (
          <fieldset
            key={x.date}
            className="grid gap-2 border-t border-border pt-3 first-of-type:border-t-0"
          >
            <legend className="font-medium">{DAY_LABEL(x.date)}</legend>
            <Windows
              name={`exception-${x.date}`}
              windows={x.windows}
              onChange={(w) =>
                set({
                  exceptions: draft.exceptions.map((e, j) => (j === i ? { ...e, windows: w } : e)),
                })
              }
            />
            <Button
              variant="secondary"
              className="justify-self-start"
              onClick={() => set({ exceptions: draft.exceptions.filter((_, j) => j !== i) })}
            >
              Убрать день
            </Button>
          </fieldset>
        ))}
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Input
            id="exception-date"
            label="Дата"
            type="date"
            min={today()}
            value={exceptionDate}
            onChange={(e) => setExceptionDate(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={!exceptionDate || draft.exceptions.some((e) => e.date === exceptionDate)}
            onClick={() => {
              set({ exceptions: [...draft.exceptions, { date: exceptionDate, windows: [] }] })
              setExceptionDate('')
            }}
          >
            Выходной
          </Button>
        </div>
      </Card>
      <div className="grid gap-2">
        <Button className="justify-self-start" disabled={save.busy} onClick={submit}>
          Сохранить
        </Button>
        {save.error ? (
          <p role="alert" className="text-danger">
            {save.error.message}
          </p>
        ) : null}
        {saved ? <p role="status">Сохранила.</p> : null}
      </div>
      <Card>
        <h2 className="font-display text-lg">Так Сара предложит время клиенту</h2>
        {view.preview.length === 0 ? (
          <p>
            Свободного времени на ближайшие дни нет: Сара попросит клиента назвать удобное время.
          </p>
        ) : (
          <ul aria-label="Так Сара предложит время" className="grid gap-1">
            {view.preview.map((p) => (
              <li key={p.startsAt}>{p.label}</li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  )
}
