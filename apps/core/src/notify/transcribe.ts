import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'

export type Transcriber = { transcribe(audioPath: string): Promise<string | null> }

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    let out = ''
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      done({ ok: false, out: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ ok: code === 0, out })
    })
  })
}

/**
 * Boris's voice messages are recognized on the server (whisper.cpp, Russian): the voice never leaves it.
 * ffmpeg turns Telegram's Opus into the 16 kHz mono wav whisper reads. Any failure is null, never a throw.
 */
export function createTranscriber(c: {
  ffmpegBin: string
  whisperBin: string
  modelPath: string
  workDir: string
  timeoutMs?: number
}): Transcriber {
  const timeoutMs = c.timeoutMs ?? 120_000
  return {
    async transcribe(audioPath) {
      await mkdir(c.workDir, { recursive: true })
      const wav = join(c.workDir, `${newEventId()}.wav`)
      try {
        const conv = await run(
          c.ffmpegBin,
          ['-y', '-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', wav],
          timeoutMs,
        )
        if (!conv.ok) return null
        const r = await run(
          c.whisperBin,
          ['-m', c.modelPath, '-l', 'ru', '-nt', '-np', '-f', wav],
          timeoutMs,
        )
        // whisper marks silence and sounds in brackets ([BLANK_AUDIO], [музыка], (смех)): those are not words.
        const text = r.out
          .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .join(' ')
        return r.ok && text ? text : null
      } finally {
        await rm(wav, { force: true })
      }
    },
  }
}
