import type { ReactNode } from 'react'
import { Button } from './ui/button'

/** FR-UI-3: the loading state of a screen. */
export function Loading({ label = 'Загружаю…' }: { label?: string }) {
  return (
    <p role="status" className="px-1 py-4 text-muted">
      {label}
    </p>
  )
}

/** FR-UI-3: what will appear here and the first step. */
export function Empty({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children?: ReactNode
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center">
      <p className="font-medium">{title}</p>
      {hint ? <p className="text-sm text-muted">{hint}</p> : null}
      {children}
    </div>
  )
}

/** FR-UI-3: what went wrong and a way to try again. */
export function ErrorState({
  message = 'Не получилось загрузить. Попробуй ещё раз.',
  onRetry,
}: {
  message?: string
  onRetry?: () => void
}) {
  return (
    <div role="alert" className="grid gap-3 rounded-lg border border-danger px-4 py-4">
      <p>{message}</p>
      {onRetry ? (
        <div>
          <Button variant="secondary" onClick={onRetry}>
            Повторить
          </Button>
        </div>
      ) : null}
    </div>
  )
}
