import { type Sent, SignedOut, talkApi } from './client'
import { createSilence, waitForAnswer } from './logic'
import { createPlayer, keepAwake, type Mic, openMic, type Played, speakLocally } from './media'

export type Phase = 'loading' | 'login' | 'idle' | 'listening' | 'sending' | 'thinking' | 'speaking'
export type Item = {
  id: string
  who: 'boris' | 'sara' | 'note'
  text: string
  at: number
  cards?: number
  pending?: boolean
  replay?: boolean
}
export type TalkView = {
  phase: Phase
  items: Item[]
  /** The microphone's loudness while listening, 0..1. */
  level: number
  /** The browser cannot measure the loudness: a tap ends the recording. */
  tapToStop: boolean
  /** When Sara began to think. */
  since: number
}

export const TALK_NOTES = {
  notHeard: 'Не разобрала',
  noMic: 'Нет доступа к микрофону. Разреши его для этого сайта в настройках Safari и нажми кнопку.',
  late: 'Сара не ответила за шесть минут. Спроси ещё раз.',
  gone: 'Ответ потерялся: Сара перезапускалась. Скажи ещё раз.',
  failed: 'Нет связи с Сарой. Проверь интернет и попробуй ещё раз.',
} as const

const uid = () => Math.random().toString(36).slice(2)

/** iOS 16.4+ lets a page say what its sound is for; elsewhere nothing happens. */
function audioSession(type: 'auto' | 'playback'): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
  if (session) session.type = type
}

/**
 * The talk itself, apart from the screen (ADR-028): listen, send, wait for Sara, play her voice, listen again for a
 * follow-up. The screen gets every change through `render`.
 */
export function createTalkEngine(render: (v: TalkView) => void) {
  let view: TalkView = { phase: 'loading', items: [], level: 0, tapToStop: false, since: 0 }
  const set = (p: Partial<TalkView>) => {
    view = { ...view, ...p }
    render(view)
  }
  const add = (i: Omit<Item, 'id' | 'at'>): string => {
    const id = uid()
    set({ items: [...view.items, { id, at: Date.now(), ...i }] })
    return id
  }
  const patch = (id: string, p: Partial<Item>) =>
    set({ items: view.items.map((i) => (i.id === id ? { ...i, ...p } : i)) })

  const player = createPlayer()
  let mic: Mic | null = null
  let recording: { stop(): Promise<Blob>; cancel(): void } | null = null
  let loop: number | null = null
  let release: () => void = () => {}
  let closeTimer: number | null = null
  /** Bumped by every stop, new recording or leaving the page: an older voice still on its way is not played. */
  let turn = 0
  /** Boris touched the page: the player is unlocked, so Sara's voice can go to the loudspeaker with the mic closed. */
  let touched = false
  document.addEventListener(
    'pointerdown',
    () => {
      touched = true
      player.unlock()
    },
    { capture: true },
  )

  const stopLoop = () => {
    if (loop !== null) window.clearInterval(loop)
    loop = null
  }
  const closeMic = () => {
    mic?.close()
    mic = null
    release()
    release = () => {}
  }
  /** Back to rest; the microphone is let go after a while, so a follow-up does not ask for it again. */
  const idle = () => {
    set({ phase: 'idle', level: 0 })
    if (closeTimer !== null) window.clearTimeout(closeTimer)
    closeTimer = window.setTimeout(() => {
      if (view.phase === 'idle') closeMic()
    }, 20_000)
  }
  const signedOut = (e: unknown) => {
    if (!(e instanceof SignedOut)) return false
    stopLoop()
    closeMic()
    set({ phase: 'login' })
    return true
  }

  /**
   * Sara's voice. After a touch the mic is closed first: iOS then plays through the loudspeaker, not the earpiece. With
   * no touch at all (the side button) the mic stays open, since only a page that is capturing may play without one.
   */
  async function say(id: string, text: string, followUp: boolean): Promise<void> {
    const mine = turn
    set({ phase: 'speaking' })
    let played: Played
    try {
      const audio = await talkApi.speak(text)
      if (mine !== turn) return
      if (touched) {
        stopLoop()
        closeMic()
        audioSession('playback')
      }
      played = audio ? await player.play(audio) : await speakLocally(text)
    } catch (e) {
      if (signedOut(e)) return
      played = 'failed'
    }
    if (mine !== turn) return
    if (played === 'blocked') patch(id, { replay: true })
    if (played === 'played' && followUp) return listen(true)
    idle()
  }

  /** After a spoken question Sara listens a few seconds for a follow-up; after a typed one she does not. */
  async function answered(sent: Sent, mine: string, spoken: boolean): Promise<void> {
    patch(mine, { text: sent.heard ?? TALK_NOTES.notHeard, pending: false })
    if (sent.reply) {
      const id = add({ who: 'sara', text: sent.reply.text, cards: sent.reply.buttons ? 1 : 0 })
      return say(id, sent.reply.text, spoken && sent.heard !== null)
    }
    if (!sent.talk) return idle()
    set({ phase: 'thinking', since: Date.now() })
    const r = await waitForAnswer(sent.talk, talkApi.answer, {
      retry: (e) => !(e instanceof SignedOut),
    })
    if (r.state === 'done') {
      const id = add({ who: 'sara', text: r.text, cards: r.cards })
      return say(id, r.text, spoken)
    }
    add({ who: 'note', text: r.state === 'late' ? TALK_NOTES.late : TALK_NOTES.gone })
    idle()
  }

  async function send(mine: string, spoken: boolean, sending: () => Promise<Sent>): Promise<void> {
    set({ phase: 'sending' })
    try {
      await answered(await sending(), mine, spoken)
    } catch (e) {
      if (signedOut(e)) return
      patch(mine, { pending: false })
      add({ who: 'note', text: TALK_NOTES.failed })
      idle()
    }
  }

  async function finish(): Promise<void> {
    stopLoop()
    const rec = recording
    recording = null
    if (!rec) return
    const audio = await rec.stop()
    if (audio.size < 1500) return idle()
    const mine = add({ who: 'boris', text: '…', pending: true })
    await send(mine, true, () => talkApi.sendVoice(audio))
  }

  async function listen(followUp = false): Promise<void> {
    turn++
    player.unlock()
    if (closeTimer !== null) window.clearTimeout(closeTimer)
    audioSession('auto')
    try {
      mic ??= await openMic()
    } catch {
      add({ who: 'note', text: TALK_NOTES.noMic })
      return idle()
    }
    talkApi.warm()
    release()
    release = await keepAwake()
    const m = mic
    recording = m.record()
    const silence = createSilence({
      threshold: 0.06,
      pauseMs: 1400,
      startWaitMs: followUp ? 6000 : 10_000,
      maxMs: 90_000,
    })
    const started = Date.now()
    set({ phase: 'listening', tapToStop: m.level() < 0, level: 0 })
    stopLoop()
    loop = window.setInterval(() => {
      const l = m.level()
      if (l < 0) {
        if (!view.tapToStop) set({ tapToStop: true })
        if (Date.now() - started > 90_000) void finish()
        return
      }
      set({ level: l })
      const step = silence.feed(l, Date.now())
      if (step === 'stop') void finish()
      if (step === 'nothing') {
        stopLoop()
        recording?.cancel()
        recording = null
        idle()
      }
    }, 100)
  }

  let loaded = false
  /** Once per page (React runs effects twice in development); again only after a login. */
  async function load(again = false): Promise<void> {
    if (loaded && !again) return
    loaded = true
    try {
      const lines = await talkApi.history()
      set({
        phase: 'idle',
        items: lines.map((l) => ({ id: uid(), who: l.author, text: l.text, at: Date.parse(l.at) })),
      })
      if (new URLSearchParams(window.location.search).get('go') === '1') {
        window.history.replaceState(null, '', window.location.pathname)
        await listen()
      }
    } catch (e) {
      if (signedOut(e)) return
      add({ who: 'note', text: TALK_NOTES.failed })
      set({ phase: 'idle' })
    }
  }

  return {
    load: () => load(),
    /** The big button: speak, end the recording, or stop Sara's voice. */
    press(): void {
      if (view.phase === 'idle') void listen()
      else if (view.phase === 'listening') void finish()
      else if (view.phase === 'speaking') {
        turn++
        player.stop()
        window.speechSynthesis?.cancel()
        idle()
      }
    },
    async type(text: string): Promise<void> {
      if (!text.trim() || view.phase !== 'idle') return
      player.unlock()
      const t = text.trim()
      const mine = add({ who: 'boris', text: t })
      await send(mine, false, async () => ({ ...(await talkApi.sendText(t)), heard: t }))
    },
    async replay(i: Item): Promise<void> {
      if (view.phase !== 'idle') return
      player.unlock()
      patch(i.id, { replay: false })
      await say(i.id, i.text, false)
    },
    async login(password: string): Promise<void> {
      await talkApi.login(password)
      set({ phase: 'loading' })
      await load(true)
    },
    /** The page is hidden: no listening and no voice in the background. */
    away(): void {
      turn++
      window.speechSynthesis?.cancel()
      stopLoop()
      recording?.cancel()
      recording = null
      player.stop()
      closeMic()
      if (view.phase === 'listening' || view.phase === 'speaking') set({ phase: 'idle', level: 0 })
    },
  }
}
