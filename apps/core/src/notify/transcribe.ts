import { spawn } from 'node:child_process'
import { chmod, chown, copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
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

/**
 * Boris's voice heard by Lora's speech service on the same server (docs/superpowers/specs/2026-11-07-topic-chat-design.md,
 * section 4): one faster-whisper model in memory for both. The voice is copied to the shared folder, the socket gets one
 * JSON line `{"op":"transcribe","path":...}` and answers one line `{"ok":true,"text":...}`. No socket, a silent service
 * or an empty text is null, never a throw; the copy is removed at once. Each null says why in the core's log, with the
 * time and the size of the voice, never its words (09.11.2026: voices came back unheard in 0.2 s and nothing told why).
 */
export function createSocketTranscriber(c: {
  socketPath: string
  dropDir: string
  timeoutMs?: number
}): Transcriber {
  const timeoutMs = c.timeoutMs ?? 120_000
  const ask = (path: string, bytes: number) =>
    new Promise<string | null>((done) => {
      let buf = ''
      let finished = false
      const started = Date.now()
      const end = (v: string | null, why?: string) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        sock.destroy()
        if (v === null && why)
          console.error(`voice socket: ${why} (${Date.now() - started} ms, ${bytes} B)`)
        done(v)
      }
      const sock = createConnection(c.socketPath)
      const timer = setTimeout(() => end(null, `no answer in ${timeoutMs} ms`), timeoutMs)
      sock.on('connect', () => sock.write(`${JSON.stringify({ op: 'transcribe', path })}\n`))
      sock.on('data', (b: Buffer) => {
        buf += b.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        try {
          const r = JSON.parse(buf.slice(0, nl)) as {
            ok?: boolean
            text?: unknown
            error?: unknown
          }
          if (!r.ok)
            return end(null, `the service failed: ${String(r.error ?? 'no reason').slice(0, 160)}`)
          if (typeof r.text !== 'string' || !r.text.trim()) return end(null, 'no words heard')
          end(r.text.trim())
        } catch {
          end(null, 'an answer that is not JSON')
        }
      })
      sock.on('error', (e) => end(null, e.message))
      sock.on('close', () => end(null, 'closed without an answer'))
    })
  return {
    async transcribe(audioPath) {
      const drop = join(c.dropDir, `${newEventId()}.oga`)
      try {
        await mkdir(c.dropDir, { recursive: true })
        await copyFile(audioPath, drop)
        // Node's copyFile gives the copy the owner and group of the source (gid 0 in the core's container), not the
        // group of the setgid folder (root:voice-share 2770), so the service (user lora, group voice-share) was refused
        // with EACCES every time (12.11.2026). The group becomes the folder's; the owner stays (-1: no change).
        await chown(drop, -1, (await stat(c.dropDir)).gid)
        await chmod(drop, 0o640)
        return await ask(drop, (await stat(drop)).size)
      } catch (e) {
        console.error('voice socket', e instanceof Error ? e.message : e)
        return null
      } finally {
        await rm(drop, { force: true })
      }
    },
  }
}
