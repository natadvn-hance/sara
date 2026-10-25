import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { go } from '../api'

/** A link inside the pult: no page reload; a new tab still works with the usual keys. */
export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        if (rest.target === '_blank') return
        e.preventDefault()
        go(href)
      }}
      {...rest}
    />
  )
}

/** A grouped list in the style of Telegram's settings (the look Boris approved on 20.10). */
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      {title ? (
        <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted">{title}</h2>
      ) : null}
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {children}
      </ul>
    </section>
  )
}

/** One row of a group: a title, an optional line under it and something on the right; a link when it has `href`. */
export function Row({
  title,
  sub,
  right,
  href,
}: {
  title: ReactNode
  sub?: ReactNode
  right?: ReactNode
  href?: string
}) {
  const body = (
    <>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate">{title}</span>
        {sub ? <span className="truncate text-sm text-muted">{sub}</span> : null}
      </span>
      {right ? <span className="shrink-0 text-sm text-muted">{right}</span> : null}
    </>
  )
  const look = 'flex min-h-11 items-center justify-between gap-3 px-4 py-2'
  return (
    <li>
      {href ? (
        <Link href={href} className={`${look} hover:bg-bg`}>
          {body}
        </Link>
      ) : (
        <div className={look}>{body}</div>
      )}
    </li>
  )
}
