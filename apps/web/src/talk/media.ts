import { recordingType } from './logic'

/**
 * The microphone and Sara's voice in the browser (ADR-028). The stream stays open while a talk goes on: iOS lets a page
 * that is capturing play sound without a tap, so Sara's answer can play when the app was opened by the side button.
 */
export type Mic = {
  /** The loudness now, 0..1; -1 when the browser gives no way to measure it (then a tap ends the recording). */
  level(): number
  record(): { stop(): Promise<Blob>; cancel(): void }
  close(): void
}

type AudioContextClass = typeof AudioContext
const AudioCtx = (): AudioContextClass | undefined =>
  window.AudioContext ??
  (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext

export async function openMic(): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  let ctx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  const Ctx = AudioCtx()
  if (Ctx) {
    try {
      ctx = new Ctx()
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(stream).connect(analyser)
      if (ctx.state !== 'running') await ctx.resume().catch(() => {})
    } catch {
      analyser = null
    }
  }
  const buf = new Float32Array(1024)
  return {
    level() {
      if (!analyser || ctx?.state !== 'running') return -1
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      return Math.min(1, Math.sqrt(sum / buf.length) * 4)
    },
    record() {
      const type = recordingType((t) => MediaRecorder.isTypeSupported?.(t) ?? false)
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      rec.start(250)
      return {
        stop: () =>
          new Promise<Blob>((done) => {
            rec.onstop = () => done(new Blob(chunks, { type: rec.mimeType || type || 'audio/mp4' }))
            if (rec.state === 'inactive') done(new Blob(chunks, { type: rec.mimeType }))
            else rec.stop()
          }),
        cancel: () => {
          rec.onstop = null
          if (rec.state !== 'inactive') rec.stop()
        },
      }
    },
    close() {
      for (const t of stream.getTracks()) t.stop()
      void ctx?.close().catch(() => {})
    },
  }
}

/** A tenth of a second of silence as WAV: played on a tap, it lets the page play Sara's voice later on iOS. */
function silentWav(): string {
  const samples = 2400
  const b = new DataView(new ArrayBuffer(44 + samples * 2))
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) b.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  b.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVEfmt ')
  b.setUint32(16, 16, true)
  b.setUint16(20, 1, true)
  b.setUint16(22, 1, true)
  b.setUint32(24, 24000, true)
  b.setUint32(28, 48000, true)
  b.setUint16(32, 2, true)
  b.setUint16(34, 16, true)
  text(36, 'data')
  b.setUint32(40, samples * 2, true)
  return URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' }))
}

export type Played = 'played' | 'blocked' | 'stopped' | 'failed'

/** Sara's voice: one audio element for the whole page, unlocked by the first tap. */
export function createPlayer() {
  const audio = new Audio()
  audio.preload = 'auto'
  let silent: string | null = null
  let finish: ((p: Played) => void) | null = null
  const end = (p: Played) => {
    const f = finish
    finish = null
    f?.(p)
  }
  audio.onended = () => end('played')
  audio.onerror = () => end('failed')
  return {
    unlock() {
      silent ??= silentWav()
      if (!audio.paused) return
      audio.src = silent
      void audio.play().catch(() => {})
    },
    play(blob: Blob): Promise<Played> {
      end('stopped')
      const url = URL.createObjectURL(blob)
      audio.src = url
      return new Promise<Played>((done) => {
        finish = (p) => {
          URL.revokeObjectURL(url)
          done(p)
        }
        audio
          .play()
          .catch((e: unknown) =>
            end(e instanceof DOMException && e.name === 'NotAllowedError' ? 'blocked' : 'failed'),
          )
      })
    },
    stop() {
      audio.pause()
      end('stopped')
    },
  }
}

/** The phone's own voice, when Sara's is not available. */
export function speakLocally(text: string): Promise<Played> {
  const synth = window.speechSynthesis
  if (!synth) return Promise.resolve('failed')
  return new Promise((done) => {
    const u = new SpeechSynthesisUtterance(text.slice(0, 900))
    u.lang = 'ru-RU'
    const voice = synth.getVoices().find((v) => v.lang.startsWith('ru'))
    if (voice) u.voice = voice
    u.onend = () => done('played')
    u.onerror = () => done('failed')
    synth.cancel()
    synth.speak(u)
  })
}

/** The screen stays on while Boris waits for the answer; nothing if the browser cannot. */
export async function keepAwake(): Promise<() => void> {
  try {
    const lock = await (
      navigator as Navigator & {
        wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> }
      }
    ).wakeLock?.request('screen')
    return () => void lock?.release().catch(() => {})
  } catch {
    return () => {}
  }
}
