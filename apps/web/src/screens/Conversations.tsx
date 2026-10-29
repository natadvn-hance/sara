import type { ConvList, ConvRow, ConvView } from '@sara/shared'
import { useState } from 'react'
import { usePress, useScreen } from '../app/data'
import { ago, hhmm, initial } from '../app/format'
import { idOf, usePath } from '../app/router'
import { Icon } from '../ui/icons'
import { A, Btn, Card, Empty, Head, Pill, Screen } from '../ui/kit'

/**
 * «Переписки» (M7 design 5.4): who waits for Boris, the chat, Sara's draft with why, and the card's buttons. A text
 * reaches a client only through «Отправить», the press of the Telegram card (the drafts mode).
 */

const GROUPS: { id: ConvRow['group']; title: string }[] = [
  { id: 'waiting', title: 'Ждут тебя' },
  { id: 'boris', title: 'Ведёшь ты' },
  { id: 'sara', title: 'Ведёт Сара' },
  { id: 'closed', title: 'Закрытые' },
]

function List({ l, current }: { l: ConvList; current: string | null }) {
  if (l.rows.length === 0)
    return (
      <Card title="Клиенты" icon="chat">
        <Empty title="Переписок пока нет">
          Когда клиент ответит на отклик, разговор появится здесь.
        </Empty>
      </Card>
    )
  return (
    <div className="grid">
      {l.drafting ? <p className="callout tone-wait">{l.drafting}</p> : null}
      {GROUPS.map((g) => {
        const rows = l.rows.filter((r) => r.group === g.id)
        if (rows.length === 0) return null
        const body = (
          <div className="list">
            {rows.map((r) => (
              <A
                key={r.id}
                to={`/conversations/${r.id}`}
                className="row"
                current={r.id === current}
              >
                <span className="avatar" aria-hidden="true">
                  {initial(r.name)}
                </span>
                <span className="row-main">
                  <span className="row-title">{r.name}</span>
                  <span className="row-sub">
                    {r.lastSide === 'us' ? 'вы: ' : r.lastSide === 'profi' ? 'Профи.ру: ' : ''}
                    {r.last ?? r.title ?? 'без сообщений'}
                  </span>
                </span>
                <span className="row-end mono">{r.lastAt ? ago(r.lastAt) : ''}</span>
              </A>
            ))}
          </div>
        )
        return (
          <Card
            key={g.id}
            title={g.title}
            icon={g.id === 'waiting' ? 'bell' : 'chat'}
            end={<span className="mono muted">{rows.length}</span>}
          >
            {g.id === 'closed' ? (
              <details>
                <summary>
                  <Icon name="right" /> Показать
                </summary>
                {body}
              </details>
            ) : (
              body
            )}
          </Card>
        )
      })}
    </div>
  )
}

/**
 * «Свой текст»: Boris's own words to the client (the say command, FR-CONV-11). It goes only by his «Отправить» and a
 * second press, and the core rereads the chat first; a key makes a double tap one message.
 */
function OwnText({ v }: { v: ConvView }) {
  const { press, busy } = usePress()
  const [text, setText] = useState<string | null>(null)
  const [sure, setSure] = useState(false)
  if (text === null)
    return (
      <div className="actions">
        <Btn size="sm" icon="chat" onClick={() => setText('')}>
          Написать своим текстом
        </Btn>
      </div>
    )
  return (
    <div className="grid" style={{ gap: 10 }}>
      <label className="kv" htmlFor="own-text">
        <span className="muted" style={{ fontSize: 13 }}>
          Твой текст клиенту: уйдёт как есть, от твоего имени
        </span>
        <textarea
          id="own-text"
          className="quote"
          rows={5}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setSure(false)
          }}
          style={{ font: 'inherit', color: 'inherit', resize: 'vertical' }}
        />
      </label>
      <div className="actions">
        {sure ? (
          <>
            <span className="text-2">Отправить {v.name} этот текст?</span>
            <Btn
              look="primary"
              icon="send"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await press('say', `/api/conversations/${v.id}/say`, {
                  text,
                  key: `${v.id}:${text.length}:${Date.now()}`,
                })
                if (ok) {
                  setText(null)
                  setSure(false)
                }
              }}
            >
              Да, отправить
            </Btn>
            <Btn onClick={() => setSure(false)}>Нет</Btn>
          </>
        ) : (
          <>
            <Btn
              look="primary"
              icon="send"
              disabled={text.trim() === ''}
              onClick={() => setSure(true)}
            >
              Отправить
            </Btn>
            <Btn onClick={() => setText(null)}>Отмена</Btn>
          </>
        )}
      </div>
    </div>
  )
}

function Draft({ v }: { v: ConvView }) {
  const { press, busy } = usePress()
  const [closing, setClosing] = useState(false)
  const d = v.draft
  return (
    <div className="card reveal draft-panel">
      {d ? (
        <>
          <div className="card-head">
            <span className="card-title">
              <Icon name="send" />
              {d.kind === 'reminder' ? 'Напоминание Сары' : 'Черновик Сары'}
            </span>
            <span className="mono muted">{ago(d.at)}</span>
          </div>
          <div className="quote draft">{d.text}</div>
          {d.why || d.tone || d.facts.length ? (
            <details>
              <summary>
                <Icon name="right" /> Почему так
              </summary>
              <div className="grid" style={{ marginTop: 10, gap: 8 }}>
                {d.why ? <p className="text-2">{d.why}</p> : null}
                {d.tone ? <Pill>тон клиента: {d.tone}</Pill> : null}
                {d.facts.length ? (
                  <div className="chips">
                    {d.facts.map((f) => (
                      <A key={f.id} to={`/mind/${encodeURIComponent(f.id)}`} className="pill">
                        <Icon name="mind" /> {f.title}
                      </A>
                    ))}
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
          {v.sendHold ? (
            <p className="callout tone-wait">Сейчас клиенту не уйдёт: {v.sendHold}.</p>
          ) : null}
          <div className="actions">
            <Btn
              look="primary"
              icon="send"
              disabled={busy !== null}
              onClick={() => press('send', `/api/tasks/${d.taskId}/send`)}
            >
              Отправить
            </Btn>
            {d.kind === 'reminder' ? (
              <Btn
                disabled={busy !== null}
                onClick={() => press('skip', `/api/tasks/${d.taskId}/skip`)}
              >
                Не надо
              </Btn>
            ) : (
              <Btn
                disabled={busy !== null}
                onClick={() => press('take', `/api/tasks/${d.taskId}/take`)}
              >
                Беру сам
              </Btn>
            )}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Изменить текст можно кнопкой «Изменить» на карточке в Telegram.
          </p>
        </>
      ) : (
        <p className="muted">Черновика нет: Сара ждёт, что ответит клиент.</p>
      )}
      {!v.closed ? <OwnText v={v} /> : null}
      {!v.closed ? (
        <div className="actions">
          {v.owner === 'boris' ? (
            <Btn
              size="sm"
              disabled={busy !== null}
              onClick={() => press('return', `/api/conversations/${v.id}/return`)}
            >
              Вернуть Саре
            </Btn>
          ) : null}
          {closing ? (
            <>
              <span className="text-2">Закрыть разговор? Сара перестанет следить за ним.</span>
              <Btn
                size="sm"
                look="danger"
                disabled={busy !== null}
                onClick={() => press('close', `/api/conversations/${v.id}/close`)}
              >
                Да, закрыть
              </Btn>
              <Btn size="sm" onClick={() => setClosing(false)}>
                Нет
              </Btn>
            </>
          ) : (
            <Btn size="sm" onClick={() => setClosing(true)}>
              Закрыть разговор
            </Btn>
          )}
        </div>
      ) : null}
    </div>
  )
}

function Conversation({ v }: { v: ConvView }) {
  return (
    <div className="grid">
      <A to="/conversations" className="back">
        <Icon name="left" /> Переписки
      </A>
      <header className="grid reveal" style={{ gap: 10 }}>
        <div className="chips">
          <Pill tone={v.closed ? 'ok' : v.owner === 'boris' ? 'wait' : 'ok'}>
            {v.closed ? 'закрыт' : v.owner === 'boris' ? 'ведёшь ты' : 'ведёт Сара'}
          </Pill>
          {v.orderId ? (
            <A to={`/leads/${encodeURIComponent(v.orderId)}`} className="pill">
              <Icon name="leads" /> {v.orderTitle ?? `заявка ${v.orderId}`}
            </A>
          ) : null}
        </div>
        <h2 className="h2">{v.name}</h2>
        {v.note ? <p className="callout tone-wait">Твоё указание: {v.note}</p> : null}
        {v.chatUrl ? (
          <a className="link" href={v.chatUrl} target="_blank" rel="noreferrer">
            Открыть на Профи.ру <Icon name="external" />
          </a>
        ) : null}
      </header>
      <Card title="Переписка" icon="chat" i={1}>
        {v.messages.length === 0 ? (
          <Empty title="Сообщений нет" />
        ) : (
          <div className="chat">
            {v.messages.map((m) => (
              <div
                key={m.id}
                className={`bubble${m.side === 'us' ? ' is-us' : m.side === 'profi' ? ' is-profi' : ''}`}
              >
                <span className="bubble-meta">
                  {m.author} ·{' '}
                  <span className="mono">{m.approx ? `около ${hhmm(m.at)}` : hhmm(m.at)}</span>
                  {m.side === 'us' && m.read ? ' · прочитано' : ''}
                </span>
                {m.text}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Draft v={v} />
    </div>
  )
}

export function ConversationsScreen() {
  const path = usePath()
  const id = idOf(path, 'conversations')
  const list = useScreen<ConvList>('/api/conversations')
  const one = useScreen<ConvView>(id ? `/api/conversations/${id}` : null)
  return (
    <div className={`page${id ? ' has-detail' : ''}`}>
      <Head
        eyebrow="Режим черновиков"
        title="Переписки"
        accent="с клиентами"
        lead="Сара готовит ответ и объясняет, почему так. Клиенту уходит только то, что ты отправил сам."
      />
      <div className={`split${id ? ' has-detail' : ''}`}>
        <div className="split-list">
          <Screen q={list}>{(l) => <List l={l} current={id} />}</Screen>
        </div>
        <div className="split-detail">
          {id ? (
            <Screen q={one}>{(v) => <Conversation v={v} />}</Screen>
          ) : (
            <Card title="Разговор" icon="chat">
              <Empty title="Выбери клиента слева">
                Здесь будут переписка, черновик Сары и кнопки.
              </Empty>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
