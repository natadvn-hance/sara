import { mkdtemp, readdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVoice } from '../../src/talk/voice'
import { ROOT } from '../helpers/app'

const FFMPEG = join(ROOT, 'tests/fakes/fake-ffmpeg.mjs')
let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

/** The voice service: answers /speak with these bytes, or with a status. */
async function fakeVoice(o: { status?: number } = {}) {
  const asked: { path: string; body: unknown }[] = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      asked.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null })
      if (req.url === '/warm') return res.writeHead(202).end('{}')
      res.writeHead(o.status ?? 200, { 'content-type': 'audio/wav' }).end('RIFF fake wav')
    })
  })
  await new Promise<void>((ok) => server?.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, asked }
}

describe('the voice app: Sara speaks with her own voice', () => {
  it('FR-NOTIF-5: the answer is spoken by xenia from the speakable text and comes back as one file', async () => {
    const v = await fakeVoice()
    const work = await mkdtemp(join(tmpdir(), 'speak-'))
    const voice = createVoice({ url: v.url, ffmpegBin: FFMPEG, workDir: work })
    const audio = await voice.speak('Отклик за 210 ₽: https://profi.ru/x')
    expect(audio?.toString()).toBe('RIFF fake wav')
    expect(v.asked).toEqual([
      {
        path: '/speak',
        body: { text: 'Отклик за двести десять рублей. Ссылки в тексте.', speaker: 'xenia' },
      },
    ])
    // Nothing of the answer stays on the disk.
    expect(await readdir(work)).toEqual([])
  })

  it('FR-NOTIF-5: a voice that fails or is not set gives null, and the answer stays text', async () => {
    const work = await mkdtemp(join(tmpdir(), 'speak-'))
    const down = await fakeVoice({ status: 503 })
    expect(
      await createVoice({ url: down.url, ffmpegBin: FFMPEG, workDir: work }).speak('Привет'),
    ).toBeNull()
    const none = createVoice({ url: null, ffmpegBin: FFMPEG, workDir: work })
    expect(await none.speak('Привет')).toBeNull()
    none.warm()
    const nowhere = createVoice({ url: 'http://127.0.0.1:9', ffmpegBin: FFMPEG, workDir: work })
    expect(await nowhere.speak('Привет')).toBeNull()
    expect(
      await createVoice({ url: down.url, ffmpegBin: FFMPEG, workDir: work }).speak('📥'),
    ).toBeNull()
  })

  it('FR-NOTIF-5: the model is warmed while Boris speaks', async () => {
    const v = await fakeVoice()
    const voice = createVoice({
      url: v.url,
      ffmpegBin: FFMPEG,
      workDir: await mkdtemp(join(tmpdir(), 's-')),
    })
    voice.warm()
    // No speaker named: the service warms both of Sara's voices.
    await expect.poll(() => v.asked).toEqual([{ path: '/warm', body: null }])
  })

  it('FR-NOTIF-5: the voice of the one who is talking is the one warmed', async () => {
    const v = await fakeVoice()
    const voice = createVoice({
      url: v.url,
      ffmpegBin: FFMPEG,
      workDir: await mkdtemp(join(tmpdir(), 's-')),
    })
    voice.warm('baya')
    await expect.poll(() => v.asked).toEqual([{ path: '/warm', body: { speaker: 'baya' } }])
  })

  it('FR-NOTIF-5: a warm that fails or has no service is silent, and speak is not touched', async () => {
    const work = await mkdtemp(join(tmpdir(), 's-'))
    expect(() =>
      createVoice({ url: null, ffmpegBin: FFMPEG, workDir: work }).warm('baya'),
    ).not.toThrow()
    const nowhere = createVoice({ url: 'http://127.0.0.1:9', ffmpegBin: FFMPEG, workDir: work })
    expect(() => nowhere.warm('baya')).not.toThrow()
    expect(await nowhere.speak('Привет', 'baya')).toBeNull()
  })

  it('FR-NOTIF-5: Lora speaks with baya, and a greeting said again needs no model', async () => {
    const v = await fakeVoice()
    const voice = createVoice({
      url: v.url,
      ffmpegBin: FFMPEG,
      workDir: await mkdtemp(join(tmpdir(), 's-')),
    })
    expect((await voice.speak('Борь, я на связи.', 'baya'))?.toString()).toBe('RIFF fake wav')
    expect((await voice.speak('Борь, я на связи.', 'baya'))?.toString()).toBe('RIFF fake wav')
    expect(v.asked).toEqual([
      { path: '/speak', body: { text: 'Борь, я на связи.', speaker: 'baya' } },
    ])
  })
})
