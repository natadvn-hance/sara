import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTranscriber } from '../src/notify/transcribe'

const ROOT = resolve(import.meta.dirname, '../../..')
const env = process.env

async function voice(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'voice-'))
  const path = join(dir, 'v.oga')
  await writeFile(path, 'OggS fake')
  return { dir, path }
}
const transcriber = (work: string) =>
  createTranscriber({
    ffmpegBin: join(ROOT, 'tests/fakes/fake-ffmpeg.mjs'),
    whisperBin: join(ROOT, 'tests/fakes/fake-whisper.mjs'),
    modelPath: '/models/ggml-small.bin',
    workDir: work,
  })
afterEach(() => {
  delete env.FAKE_WHISPER_TEXT
  delete env.FAKE_WHISPER_EXIT
})

describe('voice recognition', () => {
  it('FR-LEAD-7: a voice message becomes text', async () => {
    env.FAKE_WHISPER_TEXT = '\n бюджет копейки \n'
    const { path } = await voice()
    const work = await mkdtemp(join(tmpdir(), 'work-'))
    expect(await transcriber(work).transcribe(path)).toBe('бюджет копейки')
    // The converted file does not stay behind.
    expect(await readdir(work)).toEqual([])
  })

  it('FR-LEAD-7: a failed recognition gives null', async () => {
    const { path } = await voice()
    const work = await mkdtemp(join(tmpdir(), 'work-'))
    env.FAKE_WHISPER_TEXT = 'что-то'
    env.FAKE_WHISPER_EXIT = '1'
    expect(await transcriber(work).transcribe(path)).toBeNull()
    env.FAKE_WHISPER_EXIT = '0'
    env.FAKE_WHISPER_TEXT = '   '
    expect(await transcriber(work).transcribe(path)).toBeNull()
  })

  it('FR-LEAD-7: a missing program gives null, not a crash', async () => {
    const { path } = await voice()
    const t = createTranscriber({
      ffmpegBin: '/nowhere/ffmpeg',
      whisperBin: '/nowhere/whisper-cli',
      modelPath: '/models/x.bin',
      workDir: await mkdtemp(join(tmpdir(), 'work-')),
    })
    expect(await t.transcribe(path)).toBeNull()
  })

  it('FR-LEAD-7: silence and sound marks are not words', async () => {
    const { path } = await voice()
    const work = await mkdtemp(join(tmpdir(), 'work-'))
    env.FAKE_WHISPER_TEXT = ' [BLANK_AUDIO]\n'
    expect(await transcriber(work).transcribe(path)).toBeNull()
    env.FAKE_WHISPER_TEXT = '[музыка] (смех)'
    expect(await transcriber(work).transcribe(path)).toBeNull()
    env.FAKE_WHISPER_TEXT = '[музыка] бюджет копейки (смех)'
    expect(await transcriber(work).transcribe(path)).toBe('бюджет копейки')
  })
})
