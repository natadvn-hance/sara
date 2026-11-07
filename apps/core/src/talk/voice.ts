import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'
import { speakableText } from './speech'

export type Voice = {
  /** Loads the model ahead while Boris speaks and Sara thinks; never throws. */
  warm(): void
  /** Sara's answer in her voice as MP3, or null: no voice service, nothing to say, or it failed. */
  speak(text: string): Promise<Buffer | null>
}

/** Boris chose xenia as Sara's voice (ADR-028). */
const SPEAKER = 'xenia'

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
  return {
    warm() {
      if (!c.url) return
      void fetch(`${c.url}/warm`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(
        () => {},
      )
    },
    async speak(text) {
      const said = speakableText(text)
      if (!c.url || !/[А-Яа-яЁё]/.test(said)) return null
      const id = newEventId()
      const wav = join(c.workDir, `${id}.wav`)
      const mp3 = join(c.workDir, `${id}.mp3`)
      try {
        const res = await fetch(`${c.url}/speak`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: said, speaker: SPEAKER }),
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
        return ok ? await readFile(mp3) : null
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
