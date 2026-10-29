import type { LineTone } from '@sara/shared'
import type { ButtonHTMLAttributes, CSSProperties, PointerEvent, ReactNode } from 'react'
import { navigate } from '../app/router'
import { Icon } from './icons'

/** The pult's pieces in the landing's manner (apps/web/src/design/pult.css). */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  look?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  block?: boolean
  icon?: string
}

/** A pill button; its label rolls up on hover, as on the landing. */
export function Btn({
  look = 'ghost',
  size = 'md',
  block,
  icon,
  children,
  className = '',
  ...rest
}: BtnProps) {
  const cls = [
    'btn',
    `btn-${look}`,
    size === 'sm' ? 'btn-sm' : '',
    block ? 'btn-block' : '',
    className,
  ]
  return (
    <button type="button" className={cls.filter(Boolean).join(' ')} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {typeof children === 'string' ? (
        <span className="btn-label">
          <span>{children}</span>
          <span aria-hidden="true">{children}</span>
        </span>
      ) : (
        children
      )}
    </button>
  )
}

/** A link inside the pult: the path changes without a reload. */
export function A({
  to,
  children,
  className,
  current,
}: {
  to: string
  children: ReactNode
  className?: string
  current?: boolean
}) {
  return (
    <a
      href={to}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}

/** The coral light follows the pointer over a card. */
function glow(e: PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
}

export function Card({
  title,
  icon,
  end,
  children,
  className = '',
  i = 0,
  label,
}: {
  title?: string
  icon?: string
  end?: ReactNode
  children: ReactNode
  className?: string
  /** The order of the card's rise on the page. */
  i?: number
  label?: string
}) {
  return (
    <section
      className={`card reveal ${className}`}
      style={{ '--i': i } as CSSProperties}
      onPointerMove={glow}
      aria-label={label ?? title}
    >
      {title || end ? (
        <div className="card-head">
          {title ? (
            <h2 className="card-title">
              {icon ? <Icon name={icon} /> : null}
              {title}
            </h2>
          ) : (
            <span />
          )}
          {end}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** The page head: an eyebrow, a title with one accent word in the serif italic, and actions. */
export function Head({
  eyebrow,
  title,
  accent,
  after,
  lead,
  end,
}: {
  eyebrow?: string
  title: string
  accent?: string
  after?: string
  lead?: ReactNode
  end?: ReactNode
}) {
  return (
    <header className="head reveal">
      <div className="head-main">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1 className="h1">
          {title}
          {accent ? (
            <>
              {' '}
              <em className="accent-word">{accent}</em>
            </>
          ) : null}
          {after ? ` ${after}` : null}
        </h1>
        {lead ? <p className="lead">{lead}</p> : null}
      </div>
      {end ? <div className="actions">{end}</div> : null}
    </header>
  )
}

export function Dot({ tone, live }: { tone: LineTone; live?: boolean }) {
  return <span className={`dot tone-${tone}${live ? ' is-live' : ''}`} aria-hidden="true" />
}

export function Pill({ tone, children }: { tone?: LineTone; children: ReactNode }) {
  return (
    <span className={`pill${tone ? ` tone-${tone}` : ''}`}>
      {tone ? <Dot tone={tone} /> : null}
      {children}
    </span>
  )
}

/** A limit used so far: «3 из 10». */
export function Meter({
  label,
  value,
  max,
  text,
}: {
  label: string
  value: number
  max: number | null
  text: string
}) {
  const share = max ? Math.min(1, value / max) : 0
  return (
    <div className="meter">
      <div className="meter-top">
        <span className="text-2">{label}</span>
        <span className="mono">{text}</span>
      </div>
      {/* The words above say the figure; the bar only draws it. */}
      <div
        className={`meter-bar${max !== null && value >= max ? ' is-full' : ''}`}
        aria-hidden="true"
      >
        <span style={{ width: `${max ? share * 100 : 0}%` }} />
      </div>
    </div>
  )
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <fieldset className="seg">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  )
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="grid">
      <span className="sr-only">Загружаю</span>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder lines have no identity
        <div key={i} className="skeleton" style={{ width: `${90 - i * 17}%` }} />
      ))}
    </div>
  )
}

export function Failed({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="callout tone-bad" role="alert">
      <strong>Не получилось загрузить.</strong>
      <span className="text-2">
        {error instanceof Error ? error.message : 'Нет связи с Сарой.'}
      </span>
      <div>
        <Btn size="sm" onClick={retry}>
          Повторить
        </Btn>
      </div>
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <span className="muted">{children}</span> : null}
    </div>
  )
}

/** Data of a screen with its three states (FR-UI-3): loading, failed with «Повторить», ready. */
export function Screen<T>({
  q,
  children,
}: {
  q: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown }
  children: (data: T) => ReactNode
}) {
  if (q.data !== undefined) return <>{children(q.data)}</>
  if (q.error) return <Failed error={q.error} retry={() => void q.refetch()} />
  return <Loading lines={4} />
}
