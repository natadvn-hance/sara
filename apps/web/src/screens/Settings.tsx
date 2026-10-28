import type { SettingRow, SettingsView } from '@sara/shared'
import { useState } from 'react'
import { usePress, useScreen } from '../app/data'
import { ago, rub } from '../app/format'
import { Icon } from '../ui/icons'
import { A, Btn, Card, Head, Pill, Screen } from '../ui/kit'

/**
 * «Настройки» (M7 design 6.4): flags, limits and the rules of selection. Limits change here; a flag that takes Sara
 * out of the shadow only turns off here, its turning on stays with the developer after the checks.
 */

const hours = (v: unknown) => {
  const h = v as { from: number; to: number } | null
  return h ? `${String(h.from).padStart(2, '0')}:00-${String(h.to).padStart(2, '0')}:00` : 'нет'
}

function valueText(r: SettingRow): string {
  if (r.kind === 'flag') return r.value ? 'включено' : 'выключено'
  if (r.kind === 'rub') return r.value === null ? 'без ограничения' : rub(r.value as number)
  if (r.kind === 'hours') return hours(r.value)
  return String(r.value)
}

function Flag({ r }: { r: SettingRow }) {
  const { press, busy } = usePress()
  const [sure, setSure] = useState(false)
  const on = r.value === true
  if (r.edit === 'stop_only' && on)
    return sure ? (
      <div className="actions">
        <Btn
          size="sm"
          look="danger"
          disabled={busy !== null}
          onClick={async () => {
            await press(r.key, `/api/settings/${r.key}`, { value: false })
            setSure(false)
          }}
        >
          Да, выключить
        </Btn>
        <Btn size="sm" onClick={() => setSure(false)}>
          Нет
        </Btn>
      </div>
    ) : (
      <Btn size="sm" onClick={() => setSure(true)}>
        Поставить на паузу
      </Btn>
    )
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

function Row({ r }: { r: SettingRow }) {
  return (
    <div className="set-row">
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
      ) : r.edit === 'free' ? (
        <Limit key={String(r.value)} r={r} />
      ) : (
        <span className="mono">{valueText(r)}</span>
      )}
    </div>
  )
}

function Body({ v }: { v: SettingsView }) {
  return (
    <>
      <div className="grid grid-2">
        {v.groups.map((g, i) => (
          <Card
            key={g.id}
            title={g.title}
            icon={g.id === 'money' ? 'wallet' : g.id === 'cards' ? 'bell' : 'bolt'}
            i={i + 1}
          >
            <div>
              {g.rows.map((r) => (
                <Row key={r.key} r={r} />
              ))}
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
            <A to={`/accounts/${encodeURIComponent(d.accountId)}/direction`} className="link">
              Правила, версии и откат <Icon name="arrow" />
            </A>
          </Card>
        ))}
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
                </tr>
              </thead>
              <tbody>
                {v.history.map((h) => (
                  <tr key={`${h.key}-${h.at}`}>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

export function SettingsScreen() {
  const q = useScreen<SettingsView>('/api/settings', 60_000)
  return (
    <div className="page">
      <Head
        eyebrow="Флаги, лимиты, отбор"
        title="Настройки"
        accent="Сары"
        lead="Лимиты меняются здесь сразу. Выключить отклики или письма клиентам можно отсюда, включает их разработчик после проверок."
      />
      <Screen q={q}>{(v) => <Body v={v} />}</Screen>
    </div>
  )
}
