import type { ReactNode } from 'react'

export function Card({ children }: { children: ReactNode }) {
  return (
    <section className="grid gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6">
      {children}
    </section>
  )
}
