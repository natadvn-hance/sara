import { describe, expect, it } from 'vitest'
import { failureOf, HttpError } from '../src/talk/client'
import { firstAgent } from '../src/talk/engine'
import { createSilence, recordingType, splitSpeech, waitForAnswer } from '../src/talk/logic'

describe('the voice app: when Boris stops speaking', () => {
  it('FR-NOTIF-5: the recording ends after a pause that follows speech, not before he starts', () => {
    const s = createSilence({ threshold: 0.05, pauseMs: 1500, startWaitMs: 8000, maxMs: 60_000 })
    // Quiet before the first word: still listening.
    expect(s.feed(0.01, 0)).toBe('listen')
    expect(s.feed(0.01, 3000)).toBe('listen')
    // Speech, with a short breath inside it.
    expect(s.feed(0.2, 3100)).toBe('listen')
    expect(s.feed(0.01, 3600)).toBe('listen')
    expect(s.feed(0.3, 4000)).toBe('listen')
    // A pause long enough after speech: done.
    expect(s.feed(0.01, 4200)).toBe('listen')
    expect(s.feed(0.01, 5800)).toBe('stop')
  })

  it('FR-NOTIF-5: no word at all ends the listening empty, and a long talk is cut at the limit', () => {
    const quiet = createSilence({
      threshold: 0.05,
      pauseMs: 1500,
      startWaitMs: 6000,
      maxMs: 60_000,
    })
    expect(quiet.feed(0.01, 0)).toBe('listen')
    expect(quiet.feed(0.02, 6100)).toBe('nothing')
    const long = createSilence({ threshold: 0.05, pauseMs: 1500, startWaitMs: 6000, maxMs: 10_000 })
    expect(long.feed(0.5, 0)).toBe('listen')
    expect(long.feed(0.5, 10_100)).toBe('stop')
  })
})

describe('the voice app: the recording and the answer', () => {
  it('FR-NOTIF-5: Safari records MP4, other browsers Opus, and a browser without either its own default', () => {
    expect(recordingType((t) => t === 'audio/mp4')).toBe('audio/mp4')
    expect(recordingType((t) => t === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus')
    expect(recordingType(() => false)).toBe('')
  })

  it('FR-NOTIF-5: the app asks again until Sara answers, and says when the answer was lost', async () => {
    const replies = [
      { state: 'waiting' },
      { state: 'waiting' },
      { state: 'done', text: 'Две', cards: 0 },
    ]
    let asked = 0
    const done = await waitForAnswer('t1', async (id) => {
      expect(id).toBe('t1')
      asked++
      return replies.shift() as never
    })
    expect(done).toEqual({ state: 'done', text: 'Две', cards: 0 })
    expect(asked).toBe(3)
    const gone = await waitForAnswer('t2', async () => ({ state: 'gone' }))
    expect(gone).toEqual({ state: 'gone' })
    let now = 0
    const late = await waitForAnswer('t3', async () => ({ state: 'waiting' }), {
      deadlineMs: 1000,
      now: () => {
        now += 400
        return now
      },
    })
    expect(late).toEqual({ state: 'late' })
  })

  it('FR-NOTIF-5: a lost connection while Sara thinks is asked again, a sign-out is not', async () => {
    const replies: (Error | { state: string; text?: string; cards?: number })[] = [
      new Error('network'),
      new Error('network'),
      { state: 'waiting' },
      { state: 'done', text: 'Есть', cards: 0 },
    ]
    const pauses: number[] = []
    const done = await waitForAnswer(
      't4',
      async () => {
        const r = replies.shift()
        if (r instanceof Error) throw r
        return r as never
      },
      { pause: async (ms) => void pauses.push(ms) },
    )
    expect(done).toEqual({ state: 'done', text: 'Есть', cards: 0 })
    expect(pauses).toEqual([1000, 2000])
    class Out extends Error {}
    await expect(
      waitForAnswer(
        't5',
        async () => {
          throw new Out()
        },
        { retry: (e) => !(e instanceof Out), pause: async () => {} },
      ),
    ).rejects.toBeInstanceOf(Out)
  })
})

describe('the voice app: who answers first', () => {
  it('FR-NOTIF-5: Lora by default, Sara when the address asks for her', () => {
    expect(firstAgent('')).toBe('lora')
    expect(firstAgent('?go=1')).toBe('lora')
    expect(firstAgent('?agent=sara&go=1')).toBe('sara')
    expect(firstAgent('?agent=nobody')).toBe('lora')
  })
})

describe('the voice app: her first words come first', () => {
  it('FR-NOTIF-5: the first sentence is made and played while the rest is still being made', () => {
    expect(
      splitSpeech(
        'В очереди две заявки, обе по сайтам. Первая из Краснодара, вторая из Сочи, обе свежие.',
      ),
    ).toEqual([
      'В очереди две заявки, обе по сайтам.',
      'Первая из Краснодара, вторая из Сочи, обе свежие.',
    ])
    expect(splitSpeech('Да-да, Борь, я тут.')).toEqual(['Да-да, Борь, я тут.', ''])
    expect(splitSpeech('Ок. Сделаю.')).toEqual(['Ок. Сделаю.', ''])
  })
})

describe('the voice app: «Нет связи» says why', () => {
  it('FR-NOTIF-5: a refusal shows its code, another failure its name', () => {
    expect(failureOf(new HttpError(502, 'Bad Gateway'))).toBe('код 502')
    expect(failureOf(new TypeError('Load failed'))).toBe('TypeError')
    expect(failureOf(new Error('нет звука'))).toBe('нет звука')
  })
})
