import { randomUUID } from 'node:crypto'

/** Sara's answer to words said in the voice app (ADR-028): her text, and how many cards with buttons went to Telegram. */
export type TalkAnswer = { text: string; cards: number }

export type TalkWait =
  | { state: 'done'; answer: TalkAnswer }
  | { state: 'waiting' }
  | { state: 'gone' }

/** How long an answer waits to be fetched: the app asks again within seconds, a lost phone never does. */
const KEEP_MS = 15 * 60_000

/**
 * The answers the app waits for, in the core's memory: a talk is opened when Boris's words come in, given its answer
 * when the Secretary's turn ends, and fetched by the app's long wait. A restart of the core loses the open ones, and
 * the app asks Boris to say it again.
 */
export function createTalkAnswers(o: { now?: () => number; keepMs?: number } = {}) {
  const now = o.now ?? Date.now
  const keepMs = o.keepMs ?? KEEP_MS
  const talks = new Map<string, { at: number; answer: TalkAnswer | null; wake: (() => void)[] }>()

  const sweep = () => {
    for (const [id, t] of talks) if (now() - t.at > keepMs) talks.delete(id)
  }

  return {
    open(): string {
      sweep()
      const id = randomUUID()
      talks.set(id, { at: now(), answer: null, wake: [] })
      return id
    },
    give(ids: string[], answer: TalkAnswer): void {
      for (const id of ids) {
        const t = talks.get(id)
        if (!t || t.answer) continue
        t.answer = answer
        t.at = now()
        for (const w of t.wake.splice(0)) w()
      }
    },
    /** The answer if it is there, or after up to `ms` of waiting for it. */
    async wait(id: string, ms: number): Promise<TalkWait> {
      const t = talks.get(id)
      if (!t) return { state: 'gone' }
      if (!t.answer)
        await new Promise<void>((done) => {
          const wake = () => {
            clearTimeout(timer)
            done()
          }
          // A wait that times out takes its wake-up away, so asks again and again do not pile up.
          const timer = setTimeout(() => {
            t.wake = t.wake.filter((w) => w !== wake)
            done()
          }, ms)
          t.wake.push(wake)
        })
      return t.answer ? { state: 'done', answer: t.answer } : { state: 'waiting' }
    },
  }
}

export type TalkAnswers = ReturnType<typeof createTalkAnswers>
