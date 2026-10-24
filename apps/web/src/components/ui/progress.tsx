/** A bar for a job that takes a while: «28 из 50», and a screen reader hears it as a progress bar. */
export function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const share = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="grid gap-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-2 w-full overflow-hidden rounded-full bg-border"
      >
        <div className="h-full bg-accent" style={{ width: `${share}%` }} />
      </div>
      <p className="text-sm text-muted">{`${done} из ${total}`}</p>
    </div>
  )
}
