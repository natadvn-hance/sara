import {
  type ClientList,
  type ClientRow,
  type ClientView,
  FUNNEL_STAGES,
  type FunnelStage,
} from '@sara/shared'
import { useState } from 'react'
import { usePress, useScreen } from '../app/data'
import { ago, hhmm, initial, rub } from '../app/format'
import { idOf, usePath } from '../app/router'
import { Icon } from '../ui/icons'
import { A, Btn, Card, Empty, Head, Pill, Screen } from '../ui/kit'
import { TaskRow } from '../ui/task'

/**
 * «Клиенты» (FR-CONV-11, pult v2 design 5): every client with its stage in Boris's funnel, the chat, Sara's
 * drafts with «Отправить», his own text, «Беру сам», «Вернуть Саре», a note, the outcome and the sum.
 */

const STAGE_TONE: Record<FunnelStage, 'ok' | 'wait' | 'warn' | 'bad'> = {
  Отклик: 'wait',
  Переговоры: 'ok',
  'В работе': 'ok',
  Закрыта: 'ok',
  Отвалился: 'bad',
}

type Group = { id: string; title: string; pick: (r: ClientRow) => boolean; folded?: boolean }
const GROUPS: Group[] = [
  { id: 'waiting', title: 'Ждут тебя', pick: (r) => r.waits && !r.closed },
  { id: 'boris', title: 'Ведёшь ты', pick: (r) => !r.waits && !r.closed && r.owner === 'boris' },
  ...FUNNEL_STAGES.filter((s) => s !== 'Отвалился').map((s) => ({
    id: s,
    title: s === 'Отклик' ? 'Ждём ответа на отклик' : s,
    pick: (r: ClientRow) => !r.waits && !r.closed && r.owner === 'sara' && r.stage === s,
  })),
  {
    id: 'lost',
    title: 'Отвалились',
    pick: (r) => !r.closed && r.stage === 'Отвалился',
    folded: true,
  },
  { id: 'closed', title: 'Закрытые', pick: (r) => r.closed, folded: true },
]

function List({ l, current }: { l: ClientList; current: string | null }) {
  if (l.rows.length === 0)
    return (
      <Card title="Клиенты" icon="users">
        <Empty title="Клиентов пока нет">Когда клиент ответит на отклик, он появится здесь.</Empty>
      </Card>
    )
  return (
    <div className="grid">
      {l.drafting ? <p className="callout tone-wait">{l.drafting}</p> : null}
      {GROUPS.map((g) => {
        const rows = l.rows.filter(g.pick)
        if (rows.length === 0) return null
        const body = (
          <div className="list">
            {rows.map((r) => (
              <A key={r.id} to={`/clients/${r.id}`} className="row" current={r.id === current}>
                <span className="avatar" aria-hidden="true">
                  {initial(r.name)}
                </span>
                <span className="row-main">
                  <span className="row-title">
                    {r.name}
                    {r.waits ? (
                      <span className="dot tone-warn is-live" role="img" aria-label="ждёт тебя" />
                    ) : null}
                  </span>
                  <span className="row-sub">
                    {r.lastSide === 'us' ? 'вы: ' : r.lastSide === 'profi' ? 'Профи.ру: ' : ''}
                    {r.last ?? r.title ?? 'без сообщений'}
                  </span>
                </span>
                <span className="row-end">
                  <Pill tone={STAGE_TONE[r.stage]}>{r.stage}</Pill>
                  <span className="mono muted">{r.lastAt ? ago(r.lastAt) : ''}</span>
                </span>
              </A>
            ))}
          </div>
        )
        return (
          <Card
            key={g.id}
            title={g.title}
            icon={g.id === 'waiting' ? 'bell' : g.id === 'boris' ? 'user' : 'users'}
            end={<span className="mono muted">{rows.length}</span>}
          >
            {g.folded ? (
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

/** «Свой текст»: Boris's own words to the client (say), after his second press; the core rereads the chat first. */
function OwnText({ v }: { v: ClientView }) {
  const { press, busy } = usePress()
  const [text, setText] = useState<string | null>(null)
  const [sure, setSure] = useState(false)
  if (text === null)
    return (
      <Btn size="sm" icon="chat" onClick={() => setText('')}>
        Свой текст
      </Btn>
    )
  return (
    <div className="grid" style={{ gap: 10 }}>
      <label className="kv" htmlFor="own-text">
        <span className="muted" style={{ fontSize: 13 }}>
          Твой текст клиенту: уйдёт как есть, от твоего имени
        </span>
        <textarea
          id="own-text"
          className="field"
          rows={4}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setSure(false)
          }}
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

/** The note and the outcome: what Boris knows of the client and how the deal ended, for the funnel and the log. */
function Deal({ v }: { v: ClientView }) {
  const { press, busy } = usePress()
  const [note, setNote] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'won' | 'lost' | null>(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [service, setService] = useState(v.service ?? '')
  return (
    <Card title="Сделка" icon="money" i={3}>
      <div className="chips">
        <Pill tone={STAGE_TONE[v.stage]}>{v.stage}</Pill>
        {v.service ? <Pill>{v.service}</Pill> : null}
        <Pill>потрачено на отклик {rub(v.spentRub)}</Pill>
        {v.outcome ? (
          <Pill tone={v.outcome.outcome === 'won' ? 'ok' : 'bad'}>
            {v.outcome.outcome === 'won' ? 'договор' : 'отказ'}
            {v.outcome.amountRub !== null ? ` · ${rub(v.outcome.amountRub)}` : ''}
            {v.outcome.reason ? ` · ${v.outcome.reason}` : ''}
          </Pill>
        ) : null}
      </div>
      {note === null ? (
        <p className="text-2">
          {v.note ? <>Заметка: {v.note} </> : 'Заметки нет. '}
          <button type="button" className="link" onClick={() => setNote(v.note ?? '')}>
            {v.note ? 'Изменить' : 'Добавить заметку'}
          </button>
        </p>
      ) : (
        <div className="grid" style={{ gap: 8 }}>
          <textarea
            className="field"
            aria-label="Заметка о клиенте"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="actions">
            <Btn
              size="sm"
              look="primary"
              disabled={busy !== null}
              onClick={async () => {
                if (await press('note', `/api/clients/${v.id}/note`, { text: note })) setNote(null)
              }}
            >
              Сохранить
            </Btn>
            <Btn size="sm" onClick={() => setNote(null)}>
              Отмена
            </Btn>
          </div>
        </div>
      )}
      {outcome === null ? (
        <div className="actions">
          <Btn size="sm" icon="check" onClick={() => setOutcome('won')}>
            Договор
          </Btn>
          <Btn size="sm" icon="x" onClick={() => setOutcome('lost')}>
            Отвалился
          </Btn>
        </div>
      ) : (
        <div className="grid" style={{ gap: 8 }}>
          <div className="actions">
            <label className="kv" htmlFor="deal-service">
              <span className="muted" style={{ fontSize: 13 }}>
                Тип услуги
              </span>
              <input
                id="deal-service"
                className="field"
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="стратегия, сайт, реклама…"
              />
            </label>
            {outcome === 'won' ? (
              <label className="kv" htmlFor="deal-amount">
                <span className="muted" style={{ fontSize: 13 }}>
                  Сумма договора, ₽
                </span>
                <input
                  id="deal-amount"
                  className="field mono"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                />
              </label>
            ) : (
              <label className="kv" htmlFor="deal-reason">
                <span className="muted" style={{ fontSize: 13 }}>
                  Почему
                </span>
                <input
                  id="deal-reason"
                  className="field"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="дорого, выбрал другого, замолчал…"
                />
              </label>
            )}
          </div>
          <div className="actions">
            <Btn
              size="sm"
              look="primary"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await press('outcome', `/api/clients/${v.id}/outcome`, {
                  outcome,
                  amountRub: outcome === 'won' && amount ? Number(amount) : null,
                  reason: outcome === 'lost' && reason ? reason : null,
                  service: service || null,
                })
                if (ok) setOutcome(null)
              }}
            >
              {outcome === 'won' ? 'Записать договор' : 'Записать отказ'}
            </Btn>
            <Btn size="sm" onClick={() => setOutcome(null)}>
              Отмена
            </Btn>
          </div>
        </div>
      )}
    </Card>
  )
}

function Commands({ v }: { v: ClientView }) {
  const { press, busy } = usePress()
  const [closing, setClosing] = useState(false)
  const [returning, setReturning] = useState<string | null>(null)
  if (v.closed)
    return (
      <div className="actions">
        <Btn
          size="sm"
          icon="undo"
          disabled={busy !== null}
          onClick={() => press('return', `/api/conversations/${v.id}/return`)}
        >
          Открыть снова, пусть ведёт Сара
        </Btn>
      </div>
    )
  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="actions">
        <OwnText v={v} />
        {v.owner === 'sara' ? (
          <Btn
            size="sm"
            icon="user"
            disabled={busy !== null}
            onClick={() => press('take', `/api/conversations/${v.id}/take`)}
          >
            Беру сам
          </Btn>
        ) : returning === null ? (
          <Btn size="sm" icon="undo" onClick={() => setReturning('')}>
            Вернуть Саре
          </Btn>
        ) : null}
        {closing ? (
          <>
            <span className="text-2">Закрыть? Сара перестанет следить за этим клиентом.</span>
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
            Закрыть
          </Btn>
        )}
      </div>
      {returning !== null ? (
        <div className="grid" style={{ gap: 8 }}>
          <input
            className="field"
            aria-label="Указание Саре"
            placeholder="Как вести дальше (по желанию): «предложи созвон завтра после обеда»"
            value={returning}
            onChange={(e) => setReturning(e.target.value)}
          />
          <div className="actions">
            <Btn
              size="sm"
              look="primary"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await press(
                  'return',
                  `/api/conversations/${v.id}/return`,
                  returning.trim() ? { note: returning.trim() } : {},
                )
                if (ok) setReturning(null)
              }}
            >
              Вернуть Саре
            </Btn>
            <Btn size="sm" onClick={() => setReturning(null)}>
              Отмена
            </Btn>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Client({ v }: { v: ClientView }) {
  return (
    <div className="grid">
      <A to="/clients" className="back">
        <Icon name="left" /> Клиенты
      </A>
      <header className="grid reveal" style={{ gap: 10 }}>
        <div className="chips">
          <Pill tone={v.closed ? 'ok' : v.owner === 'boris' ? 'wait' : 'ok'}>
            {v.closed ? 'закрыт' : v.owner === 'boris' ? 'ведёшь ты' : 'ведёт Сара'}
          </Pill>
          <Pill tone={STAGE_TONE[v.stage]}>{v.stage}</Pill>
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
            Открыть чат на Профи.ру <Icon name="external" />
          </a>
        ) : null}
      </header>

      {v.tasks.length ? (
        <Card title="Ждёт тебя" icon="bell" i={1}>
          {v.sendHold ? (
            <p className="callout tone-wait">Сейчас клиенту не уйдёт: {v.sendHold}.</p>
          ) : null}
          <ol className="tasks">
            {v.tasks.map((t) => (
              <TaskRow key={t.id} item={t} />
            ))}
          </ol>
        </Card>
      ) : null}

      <Card title="Переписка" icon="chat" i={2}>
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
        <Commands v={v} />
      </Card>

      <Deal v={v} />

      {v.meetings.length ? (
        <Card title="Встречи" icon="calendar" i={4}>
          <div className="list">
            {v.meetings.map((m) => (
              <A key={m.id} to="/meetings" className="row">
                <span className="row-main">
                  <span className="row-title">{m.title}</span>
                  <span className="row-sub">
                    {m.at ? hhmm(m.at) : 'время не назначено'}
                    {m.channel ? ` · ${m.channel}` : ''}
                    {m.outcome
                      ? ` · ${m.outcome === 'held' ? 'прошла' : m.outcome === 'missed' ? 'не состоялась' : 'перенесена'}`
                      : ''}
                  </span>
                </span>
              </A>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  )
}

export function ClientsScreen() {
  const path = usePath()
  const id = idOf(path, 'clients')
  const list = useScreen<ClientList>('/api/clients')
  const one = useScreen<ClientView>(id ? `/api/clients/${id}` : null)
  return (
    <div className={`page${id ? ' has-detail' : ''}`}>
      <Head
        eyebrow="Этапы воронки"
        title="Клиенты"
        accent="Hance"
        lead="Кто ждёт тебя, кого ведёшь ты, кого ведёт Сара. Клиенту уходит только то, что ты отправил сам."
      />
      <div className={`split${id ? ' has-detail' : ''}`}>
        <div className="split-list">
          <Screen q={list}>{(l) => <List l={l} current={id} />}</Screen>
        </div>
        <div className="split-detail">
          {id ? (
            <Screen q={one}>{(v) => <Client v={v} />}</Screen>
          ) : (
            <Card title="Клиент" icon="users">
              <Empty title="Выбери клиента слева">
                Здесь будут переписка, черновик Сары, твои команды и итог сделки.
              </Empty>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
