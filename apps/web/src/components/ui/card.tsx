import type { ReactNode } from 'react'

/** The pages built before M7 take the pult's glass card (design/pult.css). */
export function Card({ children }: { children: ReactNode }) {
  return <section className="card">{children}</section>
}
