import type { TextareaHTMLAttributes } from 'react'

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }

export function Textarea({ label, hint, id, ...rest }: Props) {
  const fieldId = id ?? label
  return (
    <div className="grid gap-1">
      <label htmlFor={fieldId} className="text-sm text-muted">
        {label}
      </label>
      <textarea
        id={fieldId}
        rows={5}
        className="min-h-24 w-full min-w-0 rounded-md border border-border bg-surface px-3 py-2 text-text"
        {...rest}
      />
      {hint ? <p className="text-sm text-muted">{hint}</p> : null}
    </div>
  )
}
