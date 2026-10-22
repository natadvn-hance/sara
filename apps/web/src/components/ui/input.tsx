import type { InputHTMLAttributes } from 'react'

type Props = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null }

export function Input({ label, error, id, ...rest }: Props) {
  const inputId = id ?? label
  return (
    <div className="grid gap-1">
      <label htmlFor={inputId} className="text-sm text-muted">
        {label}
      </label>
      <input
        id={inputId}
        className="min-h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-text"
        {...rest}
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
