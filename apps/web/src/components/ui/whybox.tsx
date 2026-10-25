import type { ReactNode } from 'react'

/** «Почему так»: the reasons behind a score, folded away until asked for (FR-UI-5). */
export function WhyBox({ children }: { children: ReactNode }) {
  return (
    <details>
      <summary className="min-h-8 cursor-pointer text-sm text-accent">Почему так</summary>
      <div className="mt-2 grid gap-1 break-words text-sm">{children}</div>
    </details>
  )
}
