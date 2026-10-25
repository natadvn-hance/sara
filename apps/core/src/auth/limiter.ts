/** Failed sign-ins (a wrong password, a bad Mini App signature) per client address in the last minute. */
const failures = new Map<string, number[]>()
const WINDOW_MS = 60_000
const ALLOWED = 5

function recent(ip: string, now: number): number[] {
  return (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
}

export function recordFailure(ip: string, now = Date.now()): void {
  failures.set(ip, [...recent(ip, now), now])
}

/** More than five failures from one address in a minute: the address waits; others are not affected. */
export function blocked(ip: string, now = Date.now()): boolean {
  return recent(ip, now).length >= ALLOWED
}

/** Tests only: every test starts with a clean count. */
export function resetLimiter(): void {
  failures.clear()
}
