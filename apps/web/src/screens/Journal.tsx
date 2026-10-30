import type { JournalRow, JournalView, TraceView } from '@sara/shared'
import { useState } from 'react'
import { useScreen } from '../app/data'
import { ago, hhmm } from '../app/format'
import { usePath } from '../app/router'
import { Icon } from '../ui/icons'
import { A, Card, Empty, Head, Pill, Screen } from '../ui/kit'

/** «Журнал» (FR-OPS-4, pult v2 design 9): Sara's steps with a filter, and the trace of one chain with its model calls. */

const ACTOR_RU: Record<string, string> = {
  sara: 'Сара',
  boris: 'ты',
  system: 'система',
  client: 'клиент',
}

function Row({ r }: { r: JournalRow }) {
  return (
    <li>
      <span className="feed-time mono">{hhmm(r.at)}</span>
      <span className="feed-ic tone-ok" aria-hidden="true">
        <Icon name="clock" />
      </span>
      <span className="grid" style={{ gap: 4 }}>
        <span>{r.text}</span>
        <span className="row-sub">
          <span className="mono">{r.type}</span> · {ACTOR_RU[r.actor] ?? r.actor}
          {r.reason ? ` · ${r.reason}` : ''}
          {r.entity ? (
            <>
              {' · '}
              <A
                to={
                  r.entity.kind === 'journal'
                    ? `/journal/trace/${r.correlationId}`
                    : `/${r.entity.kind === 'lead' ? 'leads' : r.entity.kind === 'client' ? 'clients' : r.entity.kind}/${encodeURIComponent(r.entity.id)}`
                }
                className="link"
              >
                {r.entity.title}
              </A>
            </>
          ) : null}
          {' · '}
          <A to={`/journal/trace/${r.correlationId}`} className="link">
            трасса
          </A>
        </span>
      </span>
    </li>
  )
}

function Trace({ v }: { v: TraceView }) {
  return (
    <div className="grid">
      <A to="/journal" className="back">
        <Icon name="left" /> Журнал
      </A>
      <header className="grid reveal" style={{ gap: 10 }}>
        <div className="chips">
          <Pill>цепочка</Pill>
          <span className="mono muted">{v.correlationId}</span>
        </div>
        <h2 className="h2">{v.entity ? `Трасса: ${v.entity.title}` : 'Трасса'}</h2>
        {v.entity ? (
          <A
            to={
              v.entity.kind === 'lead'
                ? `/leads/${encodeURIComponent(v.entity.id)}`
                : `/clients/${v.entity.id}`
            }
            className="link"
          >
            Открыть {v.entity.kind === 'lead' ? 'заявку' : 'клиента'} <Icon name="right" />
          </A>
        ) : null}
      </header>
      <Card title="Шаги по порядку" icon="list" i={1}>
        {v.events.length === 0 ? (
          <Empty title="Шагов нет" />
        ) : (
          <ol className="feed">
            {v.events.map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </ol>
        )}
      </Card>
      <Card title="Вызовы модели" icon="mind" i={2}>
        {v.calls.length === 0 ? (
          <p className="muted">Модель в этой цепочке не звали.</p>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Роль</th>
                  <th>Модель</th>
                  <th className="n">Секунд</th>
                  <th>Итог</th>
                </tr>
              </thead>
              <tbody>
                {v.calls.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{hhmm(c.at)}</td>
                    <td>{c.role}</td>
                    <td className="mono">{c.model}</td>
                    <td className="n">{Math.round(c.ms / 1000)}</td>
                    <td>{c.ok ? 'ок' : (c.errorClass ?? 'сбой')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function List({
  v,
  type,
  setType,
}: {
  v: JournalView
  type: string
  setType: (t: string) => void
}) {
  return (
    <div className="grid">
      <div className="actions">
        <label className="kv" htmlFor="journal-type">
          <span className="muted" style={{ fontSize: 13 }}>
            Тип события
          </span>
          <select
            id="journal-type"
            className="field"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">все</option>
            {v.types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Card title="События" icon="list" end={<span className="mono muted">{v.items.length}</span>}>
        {v.items.length === 0 ? (
          <Empty title="Событий нет" />
        ) : (
          <ol className="feed">
            {v.items.map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </ol>
        )}
        {v.next ? (
          <p className="muted mono" style={{ fontSize: 13 }}>
            дальше: события старше {ago(v.next)}
          </p>
        ) : null}
      </Card>
    </div>
  )
}

export function JournalScreen() {
  const path = usePath()
  const trace = /^\/journal\/trace\/([^/?]+)/.exec(path)?.[1] ?? null
  const [type, setType] = useState('')
  const list = useScreen<JournalView>(
    trace ? null : `/api/journal${type ? `?type=${encodeURIComponent(type)}` : ''}`,
  )
  const one = useScreen<TraceView>(trace ? `/api/journal/trace/${trace}` : null)
  return (
    <div className="page">
      {trace ? null : <Head title="Журнал" />}
      {trace ? (
        <Screen q={one}>{(v) => <Trace v={v} />}</Screen>
      ) : (
        <Screen q={list}>{(v) => <List v={v} type={type} setType={setType} />}</Screen>
      )}
    </div>
  )
}
