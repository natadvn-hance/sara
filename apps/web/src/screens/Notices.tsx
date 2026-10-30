import { NOTICE_KIND_RU, type NoticeList, type NoticeRow } from '@sara/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { screenKey, usePress, useScreen } from '../app/data'
import { ago } from '../app/format'
import { Icon } from '../ui/icons'
import { A, Btn, Card, Empty, Head, Pill, Screen, Seg } from '../ui/kit'

/**
 * The bell (pult v2 design 6): the same six kinds of notifications as in Telegram, with their state: new, seen,
 * done. Opening the list marks the new ones seen; a decision anywhere marks the row done.
 */

const KIND_ICON: Record<NoticeRow['kind'], string> = {
  lead: 'leads',
  draft: 'send',
  client: 'chat',
  meeting: 'calendar',
  urgent: 'alert',
  summary: 'chart',
  system: 'health',
}

const STATE_RU: Record<NoticeRow['state'], string> = {
  new: 'новое',
  seen: 'просмотрено',
  done: 'решено',
}

function Row({ n }: { n: NoticeRow }) {
  const { press, busy } = usePress()
  const inner = (
    <>
      <span className={`score${n.state === 'new' ? ' is-high' : ''}`} aria-hidden="true">
        <Icon name={KIND_ICON[n.kind]} />
      </span>
      <span className="row-main">
        <span className="row-title">
          {n.title}
          {n.kind === 'urgent' ? <Pill tone="bad">срочно</Pill> : null}
        </span>
        <span className="row-sub">{n.body}</span>
        <span className="row-sub mono">
          {NOTICE_KIND_RU[n.kind]} · {STATE_RU[n.state]} · {ago(n.at)}
        </span>
      </span>
    </>
  )
  return (
    <div className={`row notice${n.state === 'done' ? ' is-done' : ''}`} id={n.id}>
      {n.link ? (
        <A to={n.link} className="row-link">
          {inner}
        </A>
      ) : (
        <div className="row-link">{inner}</div>
      )}
      {n.state !== 'done' && !n.taskId && !n.questionId ? (
        <Btn
          size="sm"
          disabled={busy !== null}
          onClick={() => press(n.id, `/api/notices/${n.id}/done`)}
        >
          Убрать
        </Btn>
      ) : null}
    </div>
  )
}

function Body({ v }: { v: NoticeList }) {
  const client = useQueryClient()
  const [state, setState] = useState<'open' | 'all'>('open')
  // Opened: the new ones become seen, so the bell counts only what Boris has not looked at (design 6).
  useEffect(() => {
    const ids = v.items.filter((n) => n.state === 'new').map((n) => n.id)
    if (ids.length === 0) return
    const t = setTimeout(() => {
      void api('/api/notices/seen', { ids })
        .then(() => client.invalidateQueries({ queryKey: screenKey('/api/notices?state=new') }))
        .catch(() => {})
    }, 1500)
    return () => clearTimeout(t)
  }, [v.items, client])
  const rows = state === 'open' ? v.items.filter((n) => n.state !== 'done') : v.items
  return (
    <div className="grid">
      <Seg
        label="Какие показать"
        value={state}
        onChange={setState}
        options={[
          { value: 'open', label: 'Нерешённые' },
          { value: 'all', label: 'Все' },
        ]}
      />
      <Card title="Уведомления" icon="bell" end={<span className="mono muted">{rows.length}</span>}>
        {rows.length === 0 ? (
          <Empty title="Нерешённых уведомлений нет">
            Каждое уведомление приходит и в Telegram, и сюда; решение в любом месте закрывает оба.
          </Empty>
        ) : (
          <div className="list">
            {rows.map((n) => (
              <Row key={n.id} n={n} />
            ))}
          </div>
        )}
      </Card>
      <p className="muted" style={{ fontSize: 13 }}>
        Что присылать на телефон и компьютер, настраивается в{' '}
        <A to="/settings#notify" className="link">
          Настройках
        </A>
        .
      </p>
    </div>
  )
}

export function NoticesScreen() {
  const q = useScreen<NoticeList>('/api/notices')
  return (
    <div className="page">
      <Head
        eyebrow="Telegram и пульт вместе"
        title="Уведомления"
        accent="Сары"
        lead="Заявки, черновики, клиент написал, встречи, срочное и сводки. Новое, просмотрено, решено."
      />
      <Screen q={q}>{(v) => <Body v={v} />}</Screen>
    </div>
  )
}
