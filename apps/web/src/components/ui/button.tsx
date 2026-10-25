import type { ButtonHTMLAttributes, Ref } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary'
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant = 'primary', className = '', ...rest }: Props) {
  const look =
    variant === 'primary'
      ? 'bg-accent text-white hover:opacity-90'
      : 'bg-surface text-text border border-border hover:border-muted'
  return (
    <button
      type="button"
      className={`min-h-11 rounded-md px-4 font-medium disabled:opacity-50 ${look} ${className}`}
      {...rest}
    />
  )
}
