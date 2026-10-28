import type { ButtonHTMLAttributes, Ref } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary'
  ref?: Ref<HTMLButtonElement>
}

/** The pages built before M7 take the pult's pill buttons (design/pult.css). */
export function Button({ variant = 'primary', className = '', ...rest }: Props) {
  const look = variant === 'primary' ? 'btn-primary' : 'btn-ghost'
  return <button type="button" className={`btn ${look} ${className}`} {...rest} />
}
