import { NOTICE_KIND_RU, NOTICE_KINDS, type SettingRow, type SettingsView } from '@sara/shared'
import { useState } from 'react'
import { api } from '../api'
import { usePress, useScreen } from '../app/data'
import { ago, rub } from '../app/format'
import { idOf, usePath } from '../app/router'
import { MORE } from '../app/Shell'
import { CalibrationPage } from '../pages/Calibration'
import { DirectionPage } from '../pages/Direction'
import { OnboardingPage } from '../pages/Onboarding'
import { RecomputePage } from '../pages/Recompute'
import { Icon } from '../ui/icons'
import { A, Btn, Card, Head, Pill, Screen } from '../ui/kit'

/**
 * «Настройки» (pult v2 design 8): everything of Sara in one place. The pauses and the outgoing turn on and off
 * here with a second press; the threshold changes with a hint of what it would have done; the rules of selection
 * with their versions and rollback live under the settings.
 */

const hours = (v: unknown) => {
  const h = v as { from: number; to: number } | null
  return h ? `${String(h.from).padStart(2, '0')}:00-${String(h.to).padStart(2, '0')}:00` : 'нет'
}

function valueText(r: SettingRow): string {
  if (r.kind === 'flag') return r.value ? 'включено' : 'выключено'
  if (r.kind === 'rub') return r.value === null ? 'без ограничения' : rub(r.value as number)
  if (r.kind === 'hours') return hours(r.value)
  if (r.kind === 'text') return r.value ? String(r.value) : 'выключено'
  return String(r.value)
}

/** A flag: off with one press and a second one; on the same way, when the pult may turn it on. */
function Flag({ r }: { r: SettingRow }) {
  const { press, busy } = usePress()
  const [sure, setSure] = useState(false)
  const on = r.value === true
  const can = r.edit === 'free' || r.edit === 'confirm' || (r.edit === 'stop_only' && on)
  if (!can)
    return (
      <span className="actions">
        <span
          className={`switch${on ? ' is-on' : ''}`}
          role="img"
          aria-label={on ? 'включено' : 'выключено'}
        />
        <span className="mono muted">{on ? 'вкл' : 'выкл'}</span>
      </span>
    )
  if (sure)
    return (
      <div className="actions">
        <span className="text-2">{on ? 'Выключить?' : 'Включить?'}</span>
        <Btn
          size="sm"
          look={on ? 'danger' : 'primary'}
          disabled={busy !== null}
          onClick={async () => {
            await press(r.key, `/api/settings/${r.key}`, { value: !on, confirm: true })
            setSure(false)
          }}
        >
          {on ? 'Да, выключить' : 'Да, включить'}
        </Btn>
        <Btn size="sm" onClick={() => setSure(false)}>
          Нет
        </Btn>
      </div>
    )
  return (
    <button
      type="button"
      className="actions switch-btn"
      aria-pressed={on}
      aria-label={`${r.title}: ${on ? 'включено' : 'выключено'}`}
      onClick={() => setSure(true)}
    >
      <span className={`switch${on ? ' is-on' : ''}`} aria-hidden="true" />
      <span className="mono muted">{on ? 'вкл' : 'выкл'}</span>
    </button>
  )
}

function Limit({ r }: { r: SettingRow }) {
  const { press, busy } = usePress()
  const nullable = r.kind === 'rub'
  const step = r.kind === 'rub' ? 50 : 1
  const [draft, setDraft] = useState<string>(r.value === null ? '' : String(r.value))
  const parsed = draft.trim() === '' ? null : Number(draft)
  const valid =
    (parsed === null && nullable) ||
    (parsed !== null && Number.isInteger(parsed) && parsed >= (nullable ? 0 : 1))
  const changed = (parsed ?? null) !== (r.value ?? null)
  const shift = (d: number) => setDraft(String(Math.max(nullable ? 0 : 1, (parsed ?? 0) + d)))
  return (
    <div className="actions">
      <div className="stepper">
        <button type="button" aria-label={`Меньше: ${r.title}`} onClick={() => shift(-step)}>
          −
        </button>
        <input
          aria-label={r.title}
          inputMode="numeric"
          value={draft}
          placeholder={nullable ? 'нет' : ''}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        />
        <button type="button" aria-label={`Больше: ${r.title}`} onClick={() => shift(step)}>
          +
        </button>
      </div>
      {changed ? (
        <Btn
          size="sm"
          look="primary"
          disabled={!valid || busy !== null}
          onClick={() => press(r.key, `/api/settings/${r.key}`, { value: parsed })}
        >
          Сохранить
        </Btn>
      ) : null}
    </div>
  )
}

/** A short text, Boris's Telegram nick for the end of the series; empty turns the message off. */
function Handle({ r }: { r: SettingRow }) {
  const { press, busy } = usePress()
  const [draft, setDraft] = useState(String(r.value ?? ''))
  const text = draft.trim()
  const valid = /^(@[A-Za-z0-9_]{4,32})?$/.test(text)
  return (
    <div className="actions">
      <input
        aria-label={r.title}
        value={draft}
        placeholder="@ник"
        onChange={(e) => setDraft(e.target.value)}
      />
      {text !== String(r.value ?? '') ? (
        <Btn
          size="sm"
          look="primary"
          disabled={!valid || busy !== null}
          onClick={() => press(r.key, `/api/settings/${r.key}`, { value: text })}
        >
          Сохранить
        </Btn>
      ) : null}
    </div>
  )
}

/** Hours from and to, by Moscow: the quiet hours of the cards and of the clients' night. */
function Hours({ r }: { r: SettingRow }) {
  const { press, busy } = usePress()
  const v = (r.value as { from: number; to: number } | null) ?? { from: 23, to: 9 }
  const [from, setFrom] = useState(String(v.from))
  const [to, setTo] = useState(String(v.to))
  const changed = Number(from) !== v.from || Number(to) !== v.to
  const ok = [from, to].every((x) => /^\d{1,2}$/.test(x) && Number(x) <= 23)
  const hour = (id: string, label: string, val: string, set: (s: string) => void) => (
    <label className="kv" htmlFor={id}>
      <span className="muted" style={{ fontSize: 13 }}>
        {label}
      </span>
      <input
        id={id}
        className="field mono"
        inputMode="numeric"
        style={{ width: 64 }}
        value={val}
        onChange={(e) => set(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
      />
    </label>
  )
  return (
    <div className="actions">
      {hour(`${r.key}-from`, 'с, часов', from, setFrom)}
      {hour(`${r.key}-to`, 'до, часов', to, setTo)}
      {changed ? (
        <Btn
          size="sm"
          look="primary"
          disabled={!ok || busy !== null}
          onClick={() =>
            press(r.key, `/api/settings/${r.key}`, {
              value: { from: Number(from), to: Number(to) },
            })
          }
        >
          Сохранить
        </Btn>
      ) : null}
    </div>
  )
}

function Row({ r }: { r: SettingRow }) {
  return (
    <div className="set-row" id={r.key}>
      <div className="set-text">
        <span>{r.title}</span>
        <span className="muted" style={{ fontSize: 13 }}>
          {r.hint ? `${r.hint} ` : ''}
          {r.changedAt
            ? `Менял ${r.changedBy === 'boris' ? 'ты' : r.changedBy === 'system' ? 'разработчик' : r.changedBy} ${ago(r.changedAt)}.`
            : 'Как по умолчанию.'}
        </span>
      </div>
      {r.kind === 'flag' ? (
        <Flag r={r} />
      ) : r.edit === 'free' && r.kind === 'hours' ? (
        <Hours key={JSON.stringify(r.value)} r={r} />
      ) : r.edit === 'free' && r.kind === 'text' ? (
        <Handle key={String(r.value)} r={r} />
      ) : r.edit === 'free' && (r.kind === 'count' || r.kind === 'rub') ? (
        <Limit key={String(r.value)} r={r} />
      ) : (
        <span className="mono">{valueText(r)}</span>
      )}
    </div>
  )
}

type Hint = {
  value: number
  current: number
  version: number
  cardsNow: number
  cardsWould: number
  lostYes: number
  gainedNo: number
}

/** The minimum score with a hint of the last 7 days; «Сохранить» makes a new version of the rules (M3). */
function Threshold({ d }: { d: SettingsView['directions'][number] }) {
  const { press, busy } = usePress()
  const [value, setValue] = useState(d.threshold)
  const [hint, setHint] = useState<Hint | null>(null)
  const changed = value !== d.threshold
  const shift = async (n: number) => {
    const next = Math.max(0, Math.min(100, value + n))
    setValue(next)
    try {
      setHint(
        await api<Hint>(`/api/settings/threshold/${encodeURIComponent(d.accountId)}?value=${next}`),
      )
    } catch {
      setHint(null)
    }
  }
  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="actions">
        <div className="stepper">
          <button
            type="button"
            aria-label={`Меньше: минимальный балл ${d.title}`}
            onClick={() => shift(-1)}
          >
            −
          </button>
          <input aria-label={`Минимальный балл ${d.title}`} readOnly value={value} />
          <button
            type="button"
            aria-label={`Больше: минимальный балл ${d.title}`}
            onClick={() => shift(1)}
          >
            +
          </button>
        </div>
        {changed ? (
          <>
            <Btn
              size="sm"
              look="primary"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await press(
                  'threshold',
                  `/api/settings/threshold/${encodeURIComponent(d.accountId)}`,
                  { value, expectedVersion: d.version },
                )
                if (ok) setHint(null)
              }}
            >
              Сохранить как правила v{d.version + 1}
            </Btn>
            <Btn
              size="sm"
              onClick={() => {
                setValue(d.threshold)
                setHint(null)
              }}
            >
              Отмена
            </Btn>
          </>
        ) : null}
      </div>
      {hint && changed ? (
        <p className="callout tone-wait">
          За 7 дней было бы {hint.cardsWould} карточек вместо {hint.cardsNow}; из твоих «да»
          потерялось бы {hint.lostYes}, из «нет» пришло бы {hint.gainedNo}.
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          Ниже балла заявка не приходит карточкой. Порог это часть правил отбора: сохранение создаёт
          новую версию, старую можно вернуть.
        </p>
      )}
    </div>
  )
}

/** Push to the phone and the computer by kind (pult v2 design 6). */
function Push({ r }: { r: SettingRow }) {
  const { press, busy } = usePress()
  const kinds = (r.value as Record<string, boolean> | null) ?? {}
  const [draft, setDraft] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(NOTICE_KINDS.map((k) => [k, kinds[k] ?? true])),
  )
  const changed = NOTICE_KINDS.some((k) => (kinds[k] ?? true) !== draft[k])
  return (
    <div className="set-row" id="notify">
      <div className="set-text">
        <span>{r.title}</span>
        <span className="muted" style={{ fontSize: 13 }}>
          {r.hint ?? 'Что звонит на телефоне и компьютере. В Telegram приходит всё, как раньше.'}
        </span>
        <span className="chips" style={{ marginTop: 6 }}>
          {NOTICE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`pill is-btn${draft[k] ? ' is-on' : ''}`}
              aria-pressed={draft[k]}
              onClick={() => setDraft({ ...draft, [k]: !draft[k] })}
            >
              {draft[k] ? <Icon name="check" /> : null}
              {NOTICE_KIND_RU[k]}
            </button>
          ))}
        </span>
      </div>
      <div className="actions">
        {changed ? (
          <Btn
            size="sm"
            look="primary"
            disabled={busy !== null}
            onClick={() => press(r.key, `/api/settings/${r.key}`, { value: draft })}
          >
            Сохранить
          </Btn>
        ) : null}
      </div>
    </div>
  )
}

const GROUP_ICON: Record<string, string> = {
  work: 'bolt',
  money: 'wallet',
  cards: 'bell',
  notify: 'bell',
}

function Body({ v }: { v: SettingsView }) {
  return (
    <>
      <div className="grid grid-2">
        {v.groups.map((g, i) => (
          <Card key={g.id} title={g.title} icon={GROUP_ICON[g.id] ?? 'settings'} i={i + 1}>
            <div>
              {g.rows.map((r) =>
                r.key === 'notify.push' ? <Push key={r.key} r={r} /> : <Row key={r.key} r={r} />,
              )}
            </div>
          </Card>
        ))}
        {v.directions.map((d, i) => (
          <Card
            key={d.accountId}
            title={`Отбор: ${d.title}`}
            icon="target"
            i={v.groups.length + i + 1}
            end={<Pill>правила v{d.version}</Pill>}
          >
            <div className="num">
              <b>{d.threshold}</b>
              <small>минимальный балл</small>
            </div>
            <Threshold d={d} />
            <div className="bars">
              {d.axes.map((a) => (
                <div className="bar" key={a.title}>
                  <div className="bar-top">
                    <span>{a.title}</span>
                    <span className="mono">{a.weight}%</span>
                  </div>
                  <div className="bar-track">
                    <span style={{ width: `${a.weight}%` }} />
                  </div>
                </div>
              ))}
            </div>
            {d.stops.length ? (
              <details>
                <summary>
                  <Icon name="right" /> Не предлагать ({d.stops.length})
                </summary>
                <ul className="grid" style={{ margin: '10px 0 0', paddingLeft: 18, gap: 6 }}>
                  {d.stops.map((s) => (
                    <li key={s} className="text-2">
                      {s}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <A to={`/settings/rules/${encodeURIComponent(d.accountId)}`} className="link">
              Правила отбора, версии и откат <Icon name="arrow" />
            </A>
          </Card>
        ))}
        <Card title="Разделы" icon="more" className="only-narrow">
          <div className="list">
            {MORE.filter((m) => m.id !== 'settings').map((m) => (
              <A key={m.id} to={m.to} className="row">
                <span className="row-main">
                  <span className="row-title">{m.title}</span>
                </span>
                <span className="row-end">
                  <Icon name="right" />
                </span>
              </A>
            ))}
          </div>
        </Card>
      </div>
      <Card title="История изменений" icon="clock">
        {v.history.length === 0 ? (
          <p className="muted">Настройки ещё не меняли.</p>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Что</th>
                  <th>Стало</th>
                  <th>Кто</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {v.history.map((h) => (
                  <HistoryRow key={`${h.key}-${h.at}`} h={h} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

function HistoryRow({ h }: { h: SettingsView['history'][number] }) {
  const { press, busy } = usePress()
  const locked =
    h.key.startsWith('pipeline.') || h.key === 'conv.v1_writes' || h.key === 'school.on'
  return (
    <tr>
      <td className="mono">{ago(h.at)}</td>
      <td>{h.title}</td>
      <td className="mono">
        {h.value === null
          ? 'нет'
          : typeof h.value === 'object'
            ? JSON.stringify(h.value)
            : String(h.value)}
      </td>
      <td>{h.by === 'boris' ? 'ты' : h.by === 'system' ? 'разработчик' : h.by}</td>
      <td>
        {locked ? null : (
          <Btn
            size="sm"
            icon="undo"
            disabled={busy !== null}
            onClick={() =>
              press(h.key, `/api/settings/${h.key}`, { value: h.value, confirm: true })
            }
          >
            Вернуть
          </Btn>
        )}
      </td>
    </tr>
  )
}

/** The rules of selection (M3's pages) under the settings: `/settings/rules/:accountId` and its steps. */
function Rules({ path }: { path: string }) {
  const m = /^\/settings\/rules\/([^/?]+)(?:\/(onboarding|calibration|recompute))?/.exec(path)
  const accountId = decodeURIComponent(m?.[1] ?? '')
  if (m?.[2] === 'calibration') return <CalibrationPage accountId={accountId} />
  if (m?.[2] === 'recompute') return <RecomputePage accountId={accountId} />
  if (m?.[2] === 'onboarding') return <OnboardingPage accountId={accountId} />
  return (
    <div className="grid">
      <A to="/settings" className="back">
        <Icon name="left" /> Настройки
      </A>
      <DirectionPage accountId={accountId} />
    </div>
  )
}

export function SettingsScreen() {
  const path = usePath()
  const q = useScreen<SettingsView>('/api/settings', 60_000)
  if (path.startsWith('/settings/rules/') || idOf(path, 'settings') === 'rules')
    return <div className="page">{<Rules path={path} />}</div>
  return (
    <div className="page">
      <Head title="Настройки" />
      <Screen q={q}>{(v) => <Body v={v} />}</Screen>
    </div>
  )
}
