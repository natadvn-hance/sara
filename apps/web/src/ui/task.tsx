import type { InboxAction, InboxItem } from '@sara/shared'
import { useEffect, useState } from 'react'
import { usePress } from '../app/data'
import { ago, rub } from '../app/format'
import { Icon } from './icons'
import { A, Btn } from './kit'

/**
 * One thing that waits for Boris, decided on the spot in one or two presses (FR-UI-6). The same row serves the
 * Inbox and the client's screen; its presses are the ones the Telegram card has.
 */

export const KIND_ICON: Record<string, string> = {
  lead_decision: 'leads',
  lead_review: 'leads',
  lead_held: 'leads',
  rule_proposal: 'target',
  conv_draft: 'send',
  conv_reminder: 'clock',
  conv_dormant: 'users',
  conv_say: 'chat',
  why_skip: 'bell',
  why_want: 'bell',
  why_decline: 'bell',
  edit_draft: 'note',
  edit_price: 'money',
  conv_edit: 'note',
}

export const SKIP_REASONS = ['не наш профиль', 'дорого', 'мало денег у клиента', 'уже поздно']

/** The seconds left until a held bid fires, counted on the screen. */
export function useCountdown(executeAt: string | null): number | null {
  const [left, setLeft] = useState<number | null>(null)
  useEffect(() => {
    if (!executeAt) {
      setLeft(null)
      return
    }
    const tick = () => setLeft(Math.max(0, Math.ceil((Date.parse(executeAt) - Date.now()) / 1000)))
    tick()
    const t = setInterval(tick, 250)
    return () => clearInterval(t)
  }, [executeAt])
  return left
}

/** «Откликаюсь за 210 ₽ · Отменить» with the count: the hold lives in the core, this only shows it. */
export function HoldBar({
  executeAt,
  feeRub,
  cancelPath,
}: {
  executeAt: string
  feeRub: number | null
  cancelPath: string
}) {
  const { press, busy } = usePress()
  const left = useCountdown(executeAt)
  return (
    <div className="hold" role="status">
      <span className="hold-text">
        {left === 0 ? 'Отправляю отклик…' : `Откликаюсь${feeRub ? ` за ${rub(feeRub)}` : ''}`}
        {left ? <span className="mono"> · {left} с</span> : null}
      </span>
      <Btn
        size="sm"
        look="danger"
        disabled={busy !== null || left === 0}
        onClick={() => press('cancel', cancelPath)}
      >
        Отменить
      </Btn>
    </div>
  )
}

function Act({ item, a, onDone }: { item: InboxItem; a: InboxAction; onDone?: () => void }) {
  const { press, busy } = usePress()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const key = `${item.id}:${a.id}`
  const go = async (body: unknown = {}) => {
    const ok = await press(key, a.path, body)
    if (ok) {
      setOpen(false)
      setText('')
      onDone?.()
    }
  }
  const label = a.needs === 'fee' && item.feeRub ? `${a.label} за ${rub(item.feeRub)}` : a.label
  if (!open)
    return (
      <Btn
        size="sm"
        look={a.look}
        disabled={busy !== null || (a.needs === 'fee' && !item.feeRub)}
        onClick={() => {
          if (a.needs === null) return void go()
          if (a.needs === 'fee') return void go({ expectedFeeRub: item.feeRub })
          setOpen(true)
        }}
      >
        {label}
      </Btn>
    )
  if (a.needs === 'confirm')
    return (
      <span className="actions">
        <span className="text-2">{a.label}?</span>
        <Btn
          size="sm"
          look={a.look === 'ghost' ? 'primary' : a.look}
          disabled={busy !== null}
          onClick={() => go()}
        >
          Да
        </Btn>
        <Btn size="sm" onClick={() => setOpen(false)}>
          Нет
        </Btn>
      </span>
    )
  if (a.needs === 'reason')
    return (
      <span className="grid" style={{ gap: 8 }}>
        <span className="chips">
          {SKIP_REASONS.map((r) => (
            <button key={r} type="button" className="pill is-btn" onClick={() => go({ reason: r })}>
              {r}
            </button>
          ))}
          <button type="button" className="pill is-btn" onClick={() => go()}>
            без причины
          </button>
        </span>
        <span className="actions">
          <input
            className="field"
            aria-label="Причина своими словами"
            placeholder="Или своими словами"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim()) go({ reason: text.trim() })
            }}
          />
          <Btn
            size="sm"
            look="primary"
            disabled={busy !== null || !text.trim()}
            onClick={() => go({ reason: text.trim() })}
          >
            Пропустить
          </Btn>
          <Btn size="sm" onClick={() => setOpen(false)}>
            Отмена
          </Btn>
        </span>
      </span>
    )
  return (
    <span className="grid" style={{ gap: 8 }}>
      <textarea
        className="field"
        aria-label={a.label}
        rows={3}
        placeholder="Напиши здесь"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <span className="actions">
        <Btn
          size="sm"
          look="primary"
          disabled={busy !== null || !text.trim()}
          onClick={() => go({ text: text.trim() })}
        >
          Отправить
        </Btn>
        <Btn size="sm" onClick={() => setOpen(false)}>
          Отмена
        </Btn>
      </span>
    </span>
  )
}

export function TaskRow({
  item,
  onDone,
  compact,
}: {
  item: InboxItem
  onDone?: () => void
  compact?: boolean
}) {
  const [more, setMore] = useState(false)
  const text = item.text ?? ''
  const long = text.length > 220
  return (
    <li className={`task${item.urgent ? ' is-urgent' : ''}`} id={item.id}>
      <span className={`score${item.urgent ? ' is-high' : ''}`} aria-hidden="true">
        <Icon name={KIND_ICON[item.kind] ?? 'check'} />
      </span>
      <div className="task-main">
        <div className="task-head">
          <span className="row-title">{item.title}</span>
          <span className="mono muted">{ago(item.at)}</span>
        </div>
        {item.entity ? (
          <A
            to={
              item.entity.kind === 'lead'
                ? `/leads/${encodeURIComponent(item.entity.id)}`
                : (item.link ?? '#')
            }
            className="pill"
          >
            <Icon
              name={
                item.entity.kind === 'lead'
                  ? 'leads'
                  : item.entity.kind === 'client'
                    ? 'users'
                    : 'right'
              }
            />
            {item.entity.title}
          </A>
        ) : null}
        {item.sub ? <span className="text-2">{item.sub}</span> : null}
        {text && !compact ? (
          <blockquote className="quote task-text">
            {long && !more ? `${text.slice(0, 220)}…` : text}
            {long ? (
              <button type="button" className="link" onClick={() => setMore(!more)}>
                {more ? 'Свернуть' : 'Читать целиком'}
              </button>
            ) : null}
          </blockquote>
        ) : null}
        {item.hold ? (
          <HoldBar
            executeAt={item.hold.executeAt}
            feeRub={item.feeRub}
            cancelPath={
              item.entity ? `/api/leads/${encodeURIComponent(item.entity.id)}/bid/cancel` : '#'
            }
          />
        ) : (
          <div className="actions">
            {item.actions.map((a) => (
              <Act key={a.id} item={item} a={a} onDone={onDone} />
            ))}
            {item.link ? (
              <A to={item.link} className="link">
                Открыть <Icon name="right" />
              </A>
            ) : null}
          </div>
        )}
      </div>
    </li>
  )
}
