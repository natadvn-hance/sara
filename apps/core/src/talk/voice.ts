import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'
import { speakableText } from './speech'

export type Voice = {
  /**
   * Loads the model ahead while Boris speaks and Sara thinks, and has the service say a short phrase in this voice, so
   * the first real phrase is not the slow one (6 s on 12.11.2026). No speaker: the service warms both of Sara's.
   * Never throws.
   */
  warm(speaker?: string): void
  /** The answer in this voice as MP3 (Sara's xenia by default), or null: no voice service, nothing to say, a failure. */
  speak(text: string, speaker?: string): Promise<Buffer | null>
}

/** Boris chose xenia as Sara's voice (ADR-028); Lora speaks with baya. */
const SPEAKER = 'xenia'
/** Short lines said again and again (the greetings) are kept, so a greeting needs no model at all. */
const KEEP_CHARS = 60
const KEEP_LINES = 20

function run(bin: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(bin, args, { stdio: 'ignore' })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      done(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0)
    })
  })
}

/**
 * Sara's voice through the `voice` service inside Docker (Silero, ADR-028): the text made speakable here, the WAV it
 * returns made into a small MP3 by the core's ffmpeg, both files gone right after.
 */
export function createVoice(c: {
  url: string | null
  ffmpegBin: string
  workDir: string
  timeoutMs?: number
}): Voice {
  const timeoutMs = c.timeoutMs ?? 90_000
  const kept = new Map<string, Buffer>()
  return {
    warm(speaker) {
      if (!c.url) return
      void fetch(`${c.url}/warm`, {
        method: 'POST',
        ...(speaker && {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ speaker }),
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    },
    async speak(text, speaker = SPEAKER) {
      const said = speakableText(text)
      if (!c.url || !/[А-Яа-яЁё]/.test(said)) return null
      const key = `${speaker}:${said}`
      const known = kept.get(key)
      if (known) return known
      const id = newEventId()
      const wav = join(c.workDir, `${id}.wav`)
      const mp3 = join(c.workDir, `${id}.mp3`)
      try {
        const res = await fetch(`${c.url}/speak`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: said, speaker }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) return null
        await mkdir(c.workDir, { recursive: true })
        await writeFile(wav, Buffer.from(await res.arrayBuffer()))
        const ok = await run(
          c.ffmpegBin,
          [
            '-y',
            '-loglevel',
            'error',
            '-i',
            wav,
            '-ac',
            '1',
            '-codec:a',
            'libmp3lame',
            '-b:a',
            '64k',
            mp3,
          ],
          timeoutMs,
        )
        if (!ok) return null
        const audio = await readFile(mp3)
        if (said.length <= KEEP_CHARS && kept.size < KEEP_LINES) kept.set(key, audio)
        return audio
      } catch (e) {
        console.error('voice failed', e instanceof Error ? e.message : e)
        return null
      } finally {
        await rm(wav, { force: true })
        await rm(mp3, { force: true })
      }
    },
  }
}
