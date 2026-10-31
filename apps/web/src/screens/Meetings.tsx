import type { MeetingList, MeetingRow } from '@sara/shared'
import { useState } from 'react'
import { usePress, useScreen } from '../app/data'
import { hhmm, rub } from '../app/format'
import { Icon } from '../ui/icons'
import { A, Btn, Card, Empty, Head, Pill, Screen } from '../ui/kit'

/** «Встречи» (pult v2 design 9): the calls Boris set here and the ones the chats speak of; add one, mark its outcome. */

const MSK = 'Europe/Moscow'
const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: MSK,
  })

function groupOf(
  m: MeetingRow,
  now: number,
): 'proposed' | 'today' | 'tomorrow' | 'later' | 'past' | 'done' {
  if (m.outcome) return 'done'
  if (!m.at) return 'proposed'
  const t = Date.parse(m.at)
  const day = (x: number) => new Date(x + 3 * 3600_000).toISOString().slice(0, 10)
  if (t < now - 3600_000) return 'past'
  if (day(t) === day(now)) return 'today'
  if (day(t) === day(now + 86_400_000)) return 'tomorrow'
  return 'later'
}

const GROUP_RU = {
  today: 'Сегодня',
  tomorrow: 'Завтра',
  later: 'Позже',
  past: 'Прошли, нет итога',
  proposed: 'Созвон обсуждается',
  done: 'С итогом',
} as const

function Outcome({ m }: { m: MeetingRow }) {
  const { press, busy } = usePress()
  const [open, setOpen] = useState<'held' | null>(null)
  const [amount, setAmount] = useState('')
  if (m.outcome) return null
  const go = (outcome: 'held' | 'missed' | 'moved', amountRub: number | null = null) =>
    press(m.id, `/api/meetings/${m.id}/outcome`, { outcome, amountRub })
  if (open === 'held')
    return (
      <span className="actions">
        <input
          className="field mono"
          aria-label="Сумма договора, ₽"
          placeholder="сумма, если договорились"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
        />
        <Btn
          size="sm"
          look="primary"
          disabled={busy !== null}
          onClick={() => go('held', amount ? Number(amount) : null)}
        >
          Прошла
        </Btn>
        <Btn size="sm" onClick={() => setOpen(null)}>
          Отмена
        </Btn>
      </span>
    )
  return (
    <span className="actions">
      <Btn size="sm" look="primary" onClick={() => setOpen('held')}>
        Прошла
      </Btn>
      <Btn size="sm" disabled={busy !== null} onClick={() => go('missed')}>
        Не состоялась
      </Btn>
      <Btn size="sm" disabled={busy !== null} onClick={() => go('moved')}>
        Перенесли
      </Btn>
    </span>
  )
}

function Add() {
  const { press, busy } = usePress()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [when, setWhen] = useState('')
  const [channel, setChannel] = useState('телефон')
  if (!open)
    return (
      <Btn icon="plus" onClick={() => setOpen(true)}>
        Добавить встречу
      </Btn>
    )
  return (
    <div className="grid" style={{ gap: 8 }}>
      <input
        className="field"
        aria-label="С кем и о чём"
        placeholder="С кем и о чём"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="actions">
        <input
          className="field"
          aria-label="Когда"
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
        <input
          className="field"
          aria-label="Способ связи"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        />
      </div>
      <div className="actions">
        <Btn
          look="primary"
          disabled={busy !== null || !title.trim() || !when}
          onClick={async () => {
            const ok = await press('add', '/api/meetings', {
              title: title.trim(),
              at: new Date(when).toISOString(),
              channel,
            })
            if (ok) {
              setOpen(false)
              setTitle('')
              setWhen('')
            }
          }}
        >
          Сохранить
        </Btn>
        <Btn onClick={() => setOpen(false)}>Отмена</Btn>
      </div>
    </div>
  )
}

function Body({ v }: { v: MeetingList }) {
  const now = Date.now()
  const groups = (['today', 'tomorrow', 'later', 'past', 'proposed', 'done'] as const).map((g) => ({
    id: g,
    rows: v.rows.filter((m) => groupOf(m, now) === g),
  }))
  if (v.rows.length === 0)
    return (
      <Card title="Встречи" icon="calendar">
        <Empty title="Встреч нет">
          Когда клиент согласится на созвон, он появится здесь. Можно добавить встречу самому.
        </Empty>
        <Add />
      </Card>
    )
  return (
    <div className="grid">
      {groups.map(({ id, rows }, i) =>
        rows.length ? (
          <Card
            key={id}
            title={GROUP_RU[id]}
            icon={id === 'proposed' ? 'chat' : 'calendar'}
            i={i + 1}
            end={<span className="mono muted">{rows.length}</span>}
          >
            <div className="list">
              {rows.map((m) => (
                <div key={m.id} className="row" style={{ cursor: 'default', flexWrap: 'wrap' }}>
                  <span className="row-main">
                    <span className="row-title">{m.title}</span>
                    <span className="row-sub">
                      {m.at ? `${dayOf(m.at)} ${hhmm(m.at)}` : 'время не назначено'}
                      {m.channel ? ` · ${m.channel}` : ''}
                      {m.note ? ` · ${m.note}` : ''}
                      {m.amountRub !== null ? ` · ${rub(m.amountRub)}` : ''}
                    </span>
                    {m.clientId ? (
                      <A to={`/clients/${m.clientId}`} className="pill">
                        <Icon name="users" /> {m.clientName}
                      </A>
                    ) : null}
                  </span>
                  <span className="row-end">
                    {m.outcome ? (
                      <Pill
                        tone={m.outcome === 'held' ? 'ok' : m.outcome === 'missed' ? 'bad' : 'wait'}
                      >
                        {m.outcome === 'held'
                          ? 'прошла'
                          : m.outcome === 'missed'
                            ? 'не состоялась'
                            : 'перенесена'}
                      </Pill>
                    ) : (
                      <Outcome m={m} />
                    )}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        ) : null,
      )}
      <Card title="Новая встреча" icon="plus">
        <Add />
      </Card>
    </div>
  )
}

export function MeetingsScreen() {
  const q = useScreen<MeetingList>('/api/meetings')
  return (
    <div className="page">
      <Head title="Встречи" lead="Итог встречи с суммой записывает договор клиента." />
      <Screen q={q}>{(v) => <Body v={v} />}</Screen>
    </div>
  )
}
