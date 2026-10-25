import type { ReactNode } from 'react'

/** One screen of the pult: its title and its content, 360 pixels and up. */
export function Page({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-6">
      <h1 className="font-display text-2xl">{title}</h1>
      {children}
    </main>
  )
}
