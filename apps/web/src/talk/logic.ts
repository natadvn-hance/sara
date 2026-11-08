/** The voice app's decisions that do not need a browser (ADR-028): when a recording ends, how an answer is waited for. */

export type SilenceStep = 'listen' | 'stop' | 'nothing'

/**
 * Hands-free listening: the loudness of the microphone comes in a few times a second. After speech, a pause of
 * `pauseMs` ends the recording; with no speech within `startWaitMs` it ends empty; it never runs past `maxMs`.
 */
export function createSilence(o: {
  threshold: number
  pauseMs: number
  startWaitMs: number
  maxMs: number
}) {
  let start: number | null = null
  let spoke = false
  let lastLoud = 0
  return {
    feed(level: number, at: number): SilenceStep {
      start ??= at
      if (at - start >= o.maxMs) return spoke ? 'stop' : 'nothing'
      if (level >= o.threshold) {
        spoke = true
        lastLoud = at
        return 'listen'
      }
      if (!spoke) return at - start >= o.startWaitMs ? 'nothing' : 'listen'
      return at - lastLoud >= o.pauseMs ? 'stop' : 'listen'
    },
  }
}

/** What to record in: Safari takes MP4 (AAC), Chrome and Firefox Opus; '' lets the browser choose. */
export function recordingType(supported: (type: string) => boolean): string {
  for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'])
    if (supported(t)) return t
  return ''
}

/**
 * The answer in two parts for her voice: the first sentence alone, so it is ready and playing while the rest is still
 * being made. A short answer stays whole.
 */
export function splitSpeech(text: string): [string, string] {
  const t = text.trim()
  const re = /[.!?…](?=\s)/g
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const end = m.index + 1
    if (end >= 25 && end <= 220 && t.length - end >= 20)
      return [t.slice(0, end), t.slice(end).trim()]
    if (end > 220) break
  }
  return [t, '']
}

export type TalkState =
  | { state: 'done'; text: string; cards: number }
  | { state: 'waiting' }
  | { state: 'gone' }

/**
 * Asks the core for Sara's answer until it comes: each ask waits there up to 25 seconds. A Secretary's turn lasts up
 * to four minutes, so the app gives up only after `deadlineMs`. A failed ask (the phone switched networks, the app was
 * in the background, a deploy) is asked again after a pause; only what `retry` refuses (signed out) stops the wait.
 */
export async function waitForAnswer(
  talk: string,
  ask: (talk: string) => Promise<TalkState>,
  o: {
    deadlineMs?: number
    now?: () => number
    retry?: (e: unknown) => boolean
    pause?: (ms: number) => Promise<void>
  } = {},
): Promise<Exclude<TalkState, { state: 'waiting' }> | { state: 'late' }> {
  const now = o.now ?? Date.now
  const pause = o.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const until = now() + (o.deadlineMs ?? 6 * 60_000)
  let failures = 0
  while (now() < until) {
    try {
      const r = await ask(talk)
      failures = 0
      if (r.state !== 'waiting') return r
    } catch (e) {
      if (!(o.retry?.(e) ?? true)) throw e
      failures++
      await pause(Math.min(10_000, 1000 * 2 ** Math.min(failures - 1, 4)))
    }
  }
  return { state: 'late' }
}
