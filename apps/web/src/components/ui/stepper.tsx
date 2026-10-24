export type StepItem = {
  n: number
  title: string
  state: 'done' | 'current' | 'todo' | 'soon'
  /** Present when the step can be opened. */
  onOpen?: () => void
}

const MARK = { done: '✓', current: '•', todo: '○', soon: '○' } as const

/** «Шаг N из M» and the list of steps; a step that is not built yet says «скоро» and cannot be opened. */
export function Stepper({ steps, current }: { steps: StepItem[]; current: number }) {
  return (
    <nav aria-label="Шаги настройки" className="grid gap-2">
      <p className="text-sm text-muted">{`Шаг ${current} из ${steps.length}`}</p>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {steps.map((s) => (
          <li key={s.n} aria-current={s.state === 'current' ? 'step' : undefined}>
            {s.onOpen ? (
              <button
                type="button"
                onClick={s.onOpen}
                className={`min-h-8 underline ${s.state === 'current' ? 'font-medium text-text' : 'text-accent'}`}
              >
                {`${MARK[s.state]} ${s.n}. ${s.title}`}
              </button>
            ) : (
              <span className="text-muted">
                {`${MARK[s.state]} ${s.n}. ${s.title}`}
                {s.state === 'soon' ? ' (скоро)' : ''}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
