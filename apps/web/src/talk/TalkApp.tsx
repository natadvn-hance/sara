import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Agent } from './client'
import { AGENT_UI, createTalkEngine, firstAgent, type Phase, type TalkView } from './engine'
import { HanceLogo } from './HanceLogo'
import './talk.css'

export const TALK_UI = {
  status: {
    loading: 'подключаюсь',
    login: '',
    idle: 'на связи',
    listening: 'слушаю',
    sending: 'расслышала',
    thinking: 'думаю',
    speaking: 'говорю',
  } satisfies Record<Phase, string>,
  hint: {
    idle: 'Нажми и говори',
    listening: 'Говори. Пауза закончит фразу',
    listeningTap: 'Говори. Нажми, когда закончишь',
    speaking: 'Нажми, чтобы остановить',
  },
  call: 'Позвать',
  cards: 'Кнопки в Telegram и во Входящих',
  password: 'Пароль пульта',
  enter: 'Войти',
  loginFailed: 'Не вышло войти.',
} as const

const other = (a: Agent): Agent => (a === 'lora' ? 'sara' : 'lora')
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The colour change of the whole screen as one movement: the new colour opens as a circle from her picture. Browsers
 * without view transitions get the plain transition of the page's own colour variables.
 */
function revealFrom(el: Element | null): (change: () => void) => Promise<void> {
  return async (change) => {
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { updateCallbackDone: Promise<void> }
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!doc.startViewTransition || reduced) return change()
    const r = el?.getBoundingClientRect()
    const root = document.documentElement
    root.style.setProperty('--vx', `${r ? r.left + r.width / 2 : window.innerWidth / 2}px`)
    root.style.setProperty('--vy', `${r ? r.top + r.height / 2 : window.innerHeight / 2}px`)
    await doc.startViewTransition(() => flushSync(change)).updateCallbackDone.catch(() => change())
  }
}

/**
 * The voice app (ADR-028) as a voice assistant: she is in the middle, big; a tap on her is the talk. Lora answers by
 * default, «позови Сару» or the button below calls Sara; each speaks in her own voice and colour. `?go=1` (the side
 * button's command) greets and starts listening at once when iOS allows it.
 */
export function TalkApp() {
  const [view, setView] = useState<TalkView>(() => ({
    agent: firstAgent(window.location.search),
    phase: 'loading',
    items: [],
    level: 0,
    tapToStop: false,
    since: 0,
  }))
  const orb = useRef<HTMLButtonElement | null>(null)
  const origin = useRef<Element | null>(null)
  const [engine] = useState(() =>
    createTalkEngine(setView, (change) => revealFrom(origin.current ?? orb.current)(change)),
  )
  const [now, setNow] = useState(Date.now())
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [hop, setHop] = useState(0)
  const agent = view.agent

  useEffect(() => {
    void engine.load()
    const away = () => {
      if (document.visibilityState === 'hidden') engine.away()
    }
    document.addEventListener('visibilitychange', away)
    return () => document.removeEventListener('visibilitychange', away)
  }, [engine])

  // The page's own colour (the status bar, the overscroll) follows the one who speaks; the knight hops.
  useEffect(() => {
    document.documentElement.dataset.agent = agent
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove()
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = agent === 'sara' ? '#EEF2F1' : '#F3F2EF'
    document.head.append(meta)
    setHop((h) => h + 1)
    origin.current = null
  }, [agent])

  useEffect(() => {
    if (view.phase !== 'thinking') return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [view.phase])

  const login = async (e: FormEvent) => {
    e.preventDefault()
    setLoginError('')
    try {
      await engine.login(password)
      setPassword('')
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : TALK_UI.loginFailed)
    }
  }

  if (view.phase === 'login')
    return (
      <main className="talk talk-login" data-agent={agent}>
        <form className="talk-card" onSubmit={login}>
          <HanceLogo hop={0} />
          <div className="talk-pair">
            {(['lora', 'sara'] as Agent[]).map((a) => (
              <img key={a} src={`/agents/${a}.jpg`} alt={AGENT_UI[a].name} />
            ))}
          </div>
          <label className="talk-mono" htmlFor="talk-password">
            {TALK_UI.password}
          </label>
          <input
            id="talk-password"
            className="talk-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {loginError && <p className="talk-error">{loginError}</p>}
          <button className="talk-pill" type="submit" disabled={!password}>
            {TALK_UI.enter}
          </button>
        </form>
      </main>
    )

  // One line under her name: what she says now, or what she heard, never a feed.
  const mine = view.items.filter((i) => i.agent === agent)
  const last = mine.at(-1)
  const caption =
    view.phase === 'sending' || view.phase === 'thinking'
      ? mine.findLast((i) => i.who === 'boris')?.text
      : last?.text
  const status =
    view.phase === 'thinking'
      ? `${TALK_UI.status.thinking} ${clock(now - view.since)}`
      : TALK_UI.status[view.phase]
  const hint =
    view.phase === 'listening'
      ? view.tapToStop
        ? TALK_UI.hint.listeningTap
        : TALK_UI.hint.listening
      : view.phase === 'speaking'
        ? TALK_UI.hint.speaking
        : view.phase === 'idle'
          ? TALK_UI.hint.idle
          : ''
  const busy = view.phase === 'sending' || view.phase === 'thinking' || view.phase === 'loading'
  const canCall = view.phase === 'idle' || view.phase === 'speaking'
  const next = other(agent)

  return (
    <main className={`talk talk-${view.phase}`} data-agent={agent}>
      <header className="talk-top">
        <HanceLogo hop={hop} />
        <span className="talk-mono talk-status" aria-live="polite">
          <i className="talk-dot" aria-hidden="true" />
          {status}
        </span>
      </header>

      <section className="talk-center">
        <button
          ref={orb}
          type="button"
          className="talk-orb"
          onClick={() => engine.press()}
          disabled={busy}
          aria-label={hint || AGENT_UI[agent].name}
          style={
            { '--level': String(view.phase === 'listening' ? view.level : 0) } as CSSProperties
          }
        >
          <span className="talk-aura talk-aura-1" aria-hidden="true" />
          <span className="talk-aura talk-aura-2" aria-hidden="true" />
          <span className="talk-aura talk-aura-3" aria-hidden="true" />
          <span className="talk-wave" aria-hidden="true" />
          <span className="talk-wave talk-wave-2" aria-hidden="true" />
          <span className="talk-wave talk-wave-3" aria-hidden="true" />
          <span className="talk-arc" aria-hidden="true" />
          <span className="talk-orbit" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <img key={agent} className="talk-face" src={`/agents/${agent}.jpg`} alt="" />
        </button>

        <h1 key={`n-${agent}`} className="talk-name">
          {AGENT_UI[agent].name}
        </h1>
        <p className="talk-mono talk-role">{AGENT_UI[agent].role}</p>
        <p key={`${last?.id ?? 'none'}-${view.phase}`} className="talk-caption" aria-live="polite">
          {caption ?? ''}
        </p>
        {last?.who === 'agent' && (last.cards ?? 0) > 0 && view.phase === 'idle' && (
          <a className="talk-mono talk-cards" href="/inbox">
            {TALK_UI.cards}
          </a>
        )}
      </section>

      <footer className="talk-bottom">
        <p className="talk-hint">{hint}</p>
        <button
          type="button"
          className="talk-call"
          onClick={(e) => {
            origin.current = e.currentTarget
            void engine.call(next)
          }}
          disabled={!canCall}
        >
          <img key={next} src={`/agents/${next}.jpg`} alt="" />
          <span>
            {TALK_UI.call} {AGENT_UI[next].acc}
          </span>
        </button>
      </footer>
    </main>
  )
}
