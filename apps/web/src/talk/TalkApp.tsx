import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Agent } from './client'
import { AGENT_UI, createTalkEngine, type Phase, type TalkView } from './engine'
import './talk.css'

export const TALK_UI = {
  ready: 'на связи',
  listening: 'слушает',
  sending: 'разбирает',
  thinking: 'думает',
  speaking: 'говорит',
  hintIdle: 'Нажми и говори',
  hintListening: 'Говори, я слушаю. Пауза закончит запись',
  hintListeningTap: 'Говори. Нажми, когда закончишь',
  hintSending: 'Распознаю голос',
  hintSpeaking: 'Нажми, чтобы остановить',
  empty: {
    lora: 'Спроси Лору о чём угодно. Скажи «позови Сару», и придёт Сара.',
    sara: 'Спроси Сару про заявки, клиентов и отклики. «Позови Лору» вернёт Лору.',
  },
  call: 'Позвать',
  cards: 'Кнопки пришли в Telegram и во Входящие пульта.',
  inbox: 'Открыть Входящие',
  listen: 'Послушать',
  typeHere: 'Написать',
  send: 'Отправить',
  keyboard: 'Написать текстом',
  password: 'Пароль пульта',
  enter: 'Войти',
  loginFailed: 'Не вышло войти.',
} as const

const AGENT_ORDER: Agent[] = ['lora', 'sara']
const other = (a: Agent): Agent => (a === 'lora' ? 'sara' : 'lora')

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const hhmm = (at: number) =>
  new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(at))

/** The Hance mark (the knight), as on hance.pro; it makes a knight's move when the other one comes. */
function Mark({ hop }: { hop: number }) {
  return (
    <svg key={hop} className="talk-mark" viewBox="0 0 450 450" aria-hidden="true">
      <rect width="450" height="196.579" fill="currentColor" />
      <rect x="450" width="448.421" height="225" transform="rotate(90 450 0)" fill="currentColor" />
      <path
        d="M0 410.283C0 321.918 71.6344 250.283 160 250.283L450 250.283V450.02H0L0 410.283Z"
        fill="currentColor"
      />
    </svg>
  )
}

function MicIcon({ phase }: { phase: Phase }) {
  if (phase === 'listening' || phase === 'speaking')
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
      </svg>
    )
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

function KeyboardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="3"
        y="6"
        width="18"
        height="12"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M7 10h1M11 10h1M15 10h1M7 14h10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function statusOf(v: TalkView, now: number): { status: string; hint: string } {
  switch (v.phase) {
    case 'listening':
      return {
        status: TALK_UI.listening,
        hint: v.tapToStop ? TALK_UI.hintListeningTap : TALK_UI.hintListening,
      }
    case 'sending':
      return { status: TALK_UI.sending, hint: TALK_UI.hintSending }
    case 'thinking':
      return {
        status: `${TALK_UI.thinking} ${clock(now - v.since)}`,
        hint: `${AGENT_UI[v.agent].name} думает · ${clock(now - v.since)}`,
      }
    case 'speaking':
      return { status: TALK_UI.speaking, hint: TALK_UI.hintSpeaking }
    default:
      return { status: TALK_UI.ready, hint: TALK_UI.hintIdle }
  }
}

/**
 * The colour change of the whole screen as one movement: the new colour opens as a circle from the place Boris
 * touched (or from the big button when he called her by voice). Browsers without view transitions get the plain
 * colour transition of the page's own variables.
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
    root.style.setProperty('--vy', `${r ? r.top + r.height / 2 : window.innerHeight - 120}px`)
    await doc.startViewTransition(() => flushSync(change)).updateCallbackDone.catch(() => change())
  }
}

/**
 * The voice app (ADR-028): Lora answers by default, «позови Сару» or a tap on her calls Sara; each speaks in her own
 * voice and colour. `?go=1` (the side button's command) greets and starts listening at once when iOS allows it.
 */
export function TalkApp() {
  const [view, setView] = useState<TalkView>({
    agent: 'lora',
    phase: 'loading',
    items: [],
    level: 0,
    tapToStop: false,
    since: 0,
  })
  const origin = useRef<Element | null>(null)
  const [engine] = useState(() =>
    createTalkEngine(setView, (change) => revealFrom(origin.current)(change)),
  )
  const [now, setNow] = useState(Date.now())
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [hop, setHop] = useState(0)
  const feed = useRef<HTMLDivElement | null>(null)
  const mic = useRef<HTMLButtonElement | null>(null)
  const agent = view.agent

  useEffect(() => {
    void engine.load()
    const away = () => {
      if (document.visibilityState === 'hidden') engine.away()
    }
    document.addEventListener('visibilitychange', away)
    return () => document.removeEventListener('visibilitychange', away)
  }, [engine])

  // The page's own colour (the status bar, the overscroll) follows the one who speaks.
  useEffect(() => {
    document.documentElement.dataset.agent = agent
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove()
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = agent === 'sara' ? '#EEF2F1' : '#F3F2EF'
    document.head.append(meta)
    setHop((h) => h + 1)
    origin.current = mic.current
  }, [agent])

  useEffect(() => {
    if (view.phase !== 'thinking') return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [view.phase])

  const shown = view.items.filter((i) => i.agent === agent)
  const count = shown.length
  useEffect(() => {
    if (count > 0) feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' })
  }, [count])

  const sendTyped = (e: FormEvent) => {
    e.preventDefault()
    const text = draft
    setDraft('')
    void engine.type(text)
  }

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

  const call = (to: Agent, el: Element) => {
    origin.current = el
    void engine.call(to)
  }

  if (view.phase === 'login')
    return (
      <main className="talk talk-login" data-agent={agent}>
        <form className="talk-card" onSubmit={login}>
          <div className="talk-logo">
            <Mark hop={0} />
            <span>hance</span>
          </div>
          <div className="talk-pair">
            {AGENT_ORDER.map((a) => (
              <img
                key={a}
                className="talk-face-img"
                src={`/agents/${a}.jpg`}
                alt={AGENT_UI[a].name}
              />
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

  const { status, hint } = statusOf(view, now)
  const busy = view.phase === 'sending' || view.phase === 'thinking' || view.phase === 'loading'
  const canCall = view.phase === 'idle' || view.phase === 'speaking'
  const next = other(agent)

  return (
    <main className={`talk talk-${view.phase}`} data-agent={agent}>
      <header className="talk-top">
        <div className="talk-logo">
          <Mark hop={hop} />
          <span>hance</span>
        </div>
        <span className="talk-mono talk-status" aria-live="polite">
          {AGENT_UI[agent].name} {status}
        </span>
      </header>

      <section className="talk-stage">
        <div
          className="talk-face"
          style={
            { '--level': String(view.phase === 'listening' ? view.level : 0) } as CSSProperties
          }
        >
          <span className="talk-face-ring" aria-hidden="true" />
          <img
            key={agent}
            className="talk-face-img talk-face-in"
            src={`/agents/${agent}.jpg`}
            alt=""
          />
        </div>
        <div className="talk-who">
          <h1 key={agent} className="talk-name">
            {AGENT_UI[agent].name}
          </h1>
          <p className="talk-mono talk-role">{AGENT_UI[agent].role}</p>
        </div>
        <button
          type="button"
          className="talk-other"
          onClick={(e) => call(next, e.currentTarget)}
          disabled={!canCall}
          aria-label={`${TALK_UI.call}: ${AGENT_UI[next].name}`}
        >
          <img key={next} className="talk-other-img" src={`/agents/${next}.jpg`} alt="" />
          <span className="talk-mono">
            {TALK_UI.call} {AGENT_UI[next].acc}
          </span>
        </button>
      </section>

      <div className="talk-feed" ref={feed}>
        {shown.length === 0 && view.phase !== 'loading' && (
          <p className="talk-empty">{TALK_UI.empty[agent]}</p>
        )}
        {shown.map((i) =>
          i.who === 'note' ? (
            <p key={i.id} className="talk-note">
              {i.text}
            </p>
          ) : (
            <div
              key={i.id}
              className={`talk-bubble talk-${i.who}${i.pending ? ' talk-pending' : ''}`}
            >
              <p>{i.text}</p>
              {i.who === 'agent' && (i.cards ?? 0) > 0 && (
                <p className="talk-cards">
                  {TALK_UI.cards} <a href="/inbox">{TALK_UI.inbox}</a>
                </p>
              )}
              <div className="talk-meta">
                <span className="talk-mono">{hhmm(i.at)}</span>
                {i.who === 'agent' && view.phase === 'idle' && (
                  <button
                    type="button"
                    className={`talk-replay${i.replay ? ' talk-replay-on' : ''}`}
                    onClick={() => void engine.replay(i)}
                  >
                    ▶ {TALK_UI.listen}
                  </button>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      <footer className="talk-bottom">
        {typing && (
          <form className="talk-type" onSubmit={sendTyped}>
            <input
              className="talk-input"
              placeholder={`${TALK_UI.typeHere} ${AGENT_UI[agent].dat}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              enterKeyHint="send"
            />
            <button
              className="talk-pill"
              type="submit"
              disabled={!draft.trim() || view.phase !== 'idle'}
            >
              {TALK_UI.send}
            </button>
          </form>
        )}
        <div className="talk-controls">
          <button
            type="button"
            className="talk-key"
            aria-label={TALK_UI.keyboard}
            aria-pressed={typing}
            onClick={() => setTyping((t) => !t)}
          >
            <KeyboardIcon />
          </button>
          <button
            ref={mic}
            type="button"
            className="talk-mic"
            onClick={() => engine.press()}
            disabled={busy}
            aria-label={hint}
            style={
              { '--level': String(view.phase === 'listening' ? view.level : 0) } as CSSProperties
            }
          >
            <span className="talk-ring" aria-hidden="true" />
            <MicIcon phase={view.phase} />
          </button>
          <span />
        </div>
        <p className="talk-hint">
          {view.phase === 'idle' ? `${hint} · «позови ${AGENT_UI[next].acc}»` : hint}
        </p>
      </footer>
    </main>
  )
}
