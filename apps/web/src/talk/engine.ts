import { type Agent, failureOf, type Sent, SignedOut, talkApi } from './client'
import { createSilence, splitSpeech, waitForAnswer } from './logic'
import { createPlayer, keepAwake, type Mic, openMic, type Played, speakLocally } from './media'

export type Phase = 'loading' | 'login' | 'idle' | 'listening' | 'sending' | 'thinking' | 'speaking'
export type Item = {
  id: string
  /** Whose talk it belongs to: each one has her own feed. */
  agent: Agent
  who: 'boris' | 'agent' | 'note'
  text: string
  at: number
  cards?: number
  pending?: boolean
  replay?: boolean
}
export type TalkView = {
  /** Who answers now: Lora by default. */
  agent: Agent
  phase: Phase
  items: Item[]
  /** The microphone's loudness while listening, 0..1. */
  level: number
  /** The browser cannot measure the loudness: a tap ends the recording. */
  tapToStop: boolean
  /** When Sara began to think. */
  since: number
}

export const AGENT_UI: Record<
  Agent,
  { name: string; acc: string; dat: string; role: string; greeting: string }
> = {
  lora: {
    name: 'Лора',
    acc: 'Лору',
    dat: 'Лоре',
    role: 'Личный ассистент',
    greeting: 'Борь, я на связи.',
  },
  sara: {
    name: 'Сара',
    acc: 'Сару',
    dat: 'Саре',
    role: 'Продажи и заявки',
    greeting: 'Да-да, Борь, я тут.',
  },
}

export const TALK_NOTES = {
  notHeard: 'Не разобрала',
  noMic: 'Нет доступа к микрофону. Разреши его для этого сайта в настройках Safari и нажми кнопку.',
  late: 'Ответа нет шесть минут. Спроси ещё раз.',
  gone: 'Ответ потерялся: сервер перезапускался. Скажи ещё раз.',
  failed: 'Нет связи. Проверь интернет и попробуй ещё раз.',
} as const

const uid = () => Math.random().toString(36).slice(2)

/** Who answers first: `?agent=sara` in the address, Lora otherwise. */
export function firstAgent(search: string): Agent {
  return new URLSearchParams(search).get('agent') === 'sara' ? 'sara' : 'lora'
}

/** iOS 16.4+ lets a page say what its sound is for; elsewhere nothing happens. */
function audioSession(type: 'auto' | 'playback'): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
  if (session) session.type = type
}

/**
 * The talk itself, apart from the screen (ADR-028): listen, send, wait for Sara, play her voice, listen again for a
 * follow-up. The screen gets every change through `render`.
 */
export function createTalkEngine(
  render: (v: TalkView) => void,
  /** The colour change, done inside the screen's own transition when the browser has one; resolves once it is shown. */
  transition: (change: () => void) => Promise<void> = async (change) => change(),
) {
  let view: TalkView = {
    agent: firstAgent(window.location.search),
    phase: 'loading',
    items: [],
    level: 0,
    tapToStop: false,
    since: 0,
  }
  const set = (p: Partial<TalkView>) => {
    view = { ...view, ...p }
    render(view)
  }
  const add = (i: Omit<Item, 'id' | 'at' | 'agent'> & { agent?: Agent }): string => {
    const id = uid()
    set({ items: [...view.items, { id, at: Date.now(), agent: view.agent, ...i }] })
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
  /** `followUp`: listen after, a few seconds for a follow-up; `'first'`: the first question after a greeting. */
  async function say(id: string, text: string, followUp: boolean | 'first'): Promise<void> {
    const mine = turn
    const agent = view.agent
    set({ phase: 'speaking' })
    let played: Played
    try {
      // Both parts are asked for at once: the first plays while the second is still being made.
      const [first, rest] = splitSpeech(text)
      const firstAudio = talkApi.speak(first, agent)
      const restAudio = rest ? talkApi.speak(rest, agent) : Promise.resolve(null)
      restAudio.catch(() => {})
      const audio = await firstAudio
      if (mine !== turn) return
      if (touched) {
        stopLoop()
        closeMic()
        audioSession('playback')
      }
      if (!audio) played = await speakLocally(text)
      else {
        played = await player.play(audio)
        if (played === 'played' && rest && mine === turn) {
          const more = await restAudio.catch(() => null)
          if (mine === turn) played = more ? await player.play(more) : await speakLocally(rest)
        }
      }
    } catch (e) {
      if (signedOut(e)) return
      played = 'failed'
    }
    if (mine !== turn) return
    if (played === 'blocked') patch(id, { replay: true })
    if (played === 'played' && followUp) return listen(followUp === true)
    idle()
  }

  /** After a spoken question Sara listens a few seconds for a follow-up; after a typed one she does not. */
  /** The other one comes: the colour changes; what she says next is hers, in her feed and her voice. */
  async function become(agent: Agent): Promise<void> {
    if (agent === view.agent) return
    await transition(() => set({ agent }))
    // Whatever the browser did with the transition, she is the one from now on.
    if (view.agent !== agent) set({ agent })
  }

  async function answered(sent: Sent, mine: string, spoken: boolean): Promise<void> {
    patch(mine, { text: sent.heard ?? TALK_NOTES.notHeard, pending: false })
    if (sent.switch) await become(sent.switch)
    if (sent.reply) {
      const id = add({ who: 'agent', text: sent.reply.text, cards: sent.reply.buttons ? 1 : 0 })
      return say(id, sent.reply.text, spoken && sent.heard !== null)
    }
    if (!sent.talk) return idle()
    set({ phase: 'thinking', since: Date.now() })
    const r = await waitForAnswer(sent.talk, talkApi.answer, {
      retry: (e) => !(e instanceof SignedOut),
    })
    if (r.state === 'done') {
      const id = add({ who: 'agent', text: r.text, cards: r.cards })
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
      add({ who: 'note', text: `${TALK_NOTES.failed} (${failureOf(e)})` })
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
    const agent = view.agent
    await send(mine, true, () => talkApi.sendVoice(audio, agent))
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
      pauseMs: 900,
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

  /** She greets: her line in the feed and in her voice; with the side button the mic is opened first. */
  async function greet(followUp: boolean): Promise<void> {
    const text = AGENT_UI[view.agent].greeting
    const id = add({ who: 'agent', text })
    if (!touched)
      try {
        mic ??= await openMic()
      } catch {}
    await say(id, text, followUp ? 'first' : false)
  }

  let loaded = false
  /** Once per page (React runs effects twice in development); again only after a login. */
  async function load(again = false): Promise<void> {
    if (loaded && !again) return
    loaded = true
    try {
      const params = new URLSearchParams(window.location.search)
      // No feed to fill: the voice is woken at once instead, so her first answer is not slowed by the model's load.
      await talkApi.start()
      set({ phase: 'idle' })
      if (params.get('go') === '1') {
        window.history.replaceState(null, '', window.location.pathname)
        await greet(true)
      }
    } catch (e) {
      if (signedOut(e)) return
      add({ who: 'note', text: `${TALK_NOTES.failed} (${failureOf(e)})` })
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
      const agent = view.agent
      const mine = add({ who: 'boris', text: t })
      await send(mine, false, async () => ({ ...(await talkApi.sendText(t, agent)), heard: t }))
    },
    /** A tap on her picture: the other one comes and greets. */
    async call(agent: Agent): Promise<void> {
      if (agent === view.agent || (view.phase !== 'idle' && view.phase !== 'speaking')) return
      turn++
      player.stop()
      window.speechSynthesis?.cancel()
      await become(agent)
      await greet(false)
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
