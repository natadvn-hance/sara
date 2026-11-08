/** A word from Boris for Lora, waiting for her channel to take it. */
export type LoraWord = { talk: string; text: string; voice: boolean; at: string }
export type LoraLine = { author: 'boris' | 'lora'; text: string; at: string }

/** A channel that asked within this time is on the line: its long waits come one after another. */
const ONLINE_MS = 90_000
/** What the app shows of the talk with Lora: her own memory is her session's, this is only the screen. */
const HISTORY = 40

/**
 * The voice app's link to Lora (ADR-028): her session on the server takes Boris's words through her own channel, as
 * it takes Telegram, by a long wait on the core (`next`), and gives her answer back (`reply`). The core keeps nothing
 * of it but the last lines for the screen, in memory.
 */
export function createLoraLink(o: { now?: () => number } = {}) {
  const now = o.now ?? Date.now
  const queue: LoraWord[] = []
  const wake: (() => void)[] = []
  const lines: LoraLine[] = []
  let lastSeen = Number.NEGATIVE_INFINITY

  const remember = (l: LoraLine) => {
    lines.push(l)
    if (lines.length > HISTORY) lines.splice(0, lines.length - HISTORY)
  }

  return {
    connected: () => now() - lastSeen < ONLINE_MS,
    push(w: LoraWord): void {
      queue.push(w)
      remember({ author: 'boris', text: w.text, at: w.at })
      for (const f of wake.splice(0)) f()
    },
    /**
     * The next word for Lora, or null after `ms` with none. A request that has gone (`signal`, the channel cut its ask)
     * takes nothing: its word stays in the queue for the next ask, never lost to a closed socket.
     */
    async next(ms: number, signal?: AbortSignal): Promise<LoraWord | null> {
      lastSeen = now()
      if (queue.length === 0 && !signal?.aborted)
        await new Promise<void>((done) => {
          const finish = () => {
            clearTimeout(timer)
            const i = wake.indexOf(finish)
            if (i >= 0) wake.splice(i, 1)
            signal?.removeEventListener('abort', finish)
            done()
          }
          const timer = setTimeout(finish, ms)
          wake.push(finish)
          signal?.addEventListener('abort', finish, { once: true })
        })
      // The word is taken a tick later, so a request closing in the same moment as the word comes keeps away from it.
      await new Promise<void>((r) => setImmediate(r))
      if (signal?.aborted) return null
      lastSeen = now()
      return queue.shift() ?? null
    },
    reply(_talk: string, text: string): void {
      remember({ author: 'lora', text, at: new Date(now()).toISOString() })
    },
    history: (): LoraLine[] => [...lines],
  }
}

export type LoraLink = ReturnType<typeof createLoraLink>
