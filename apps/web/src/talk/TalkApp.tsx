import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from 'react'
import { createTalkEngine, type Phase, type TalkView } from './engine'
import './talk.css'

export const TALK_UI = {
  ready: 'Готова',
  listening: 'Слушаю',
  sending: 'Распознаю',
  thinking: 'Думает',
  speaking: 'Говорит',
  hintIdle: 'Нажми и говори',
  hintListening: 'Говори, я слушаю. Пауза закончит запись',
  hintListeningTap: 'Говори. Нажми, когда закончишь',
  hintSending: 'Распознаю голос',
  hintThinking: 'Сара думает',
  hintSpeaking: 'Нажми, чтобы остановить',
  empty:
    'Спроси Сару голосом: «что в очереди», «почему не откликнулась», «поставь на паузу до утра».',
  cards: 'Кнопки пришли в Telegram и во Входящие пульта.',
  inbox: 'Открыть Входящие',
  listen: 'Послушать',
  typeHere: 'Написать Саре',
  send: 'Отправить',
  keyboard: 'Написать текстом',
  password: 'Пароль пульта',
  enter: 'Войти',
  loginFailed: 'Не вышло войти.',
} as const

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const hhmm = (at: number) =>
  new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(at))

/** The Hance mark (the knight), as on hance.pro. */
function Mark() {
  return (
    <svg className="talk-mark" viewBox="0 0 450 450" aria-hidden="true">
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
        hint: `${TALK_UI.hintThinking} · ${clock(now - v.since)}`,
      }
    case 'speaking':
      return { status: TALK_UI.speaking, hint: TALK_UI.hintSpeaking }
    default:
      return { status: TALK_UI.ready, hint: TALK_UI.hintIdle }
  }
}

/**
 * The voice app (ADR-028): one big button, the chat with Sara, her answers as text and in her voice. `?go=1` (the
 * side button's command) starts listening at once when iOS allows it.
 */
export function TalkApp() {
  const [view, setView] = useState<TalkView>({
    phase: 'loading',
    items: [],
    level: 0,
    tapToStop: false,
    since: 0,
  })
  const [engine] = useState(() => createTalkEngine(setView))
  const [now, setNow] = useState(Date.now())
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const feed = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void engine.load()
    const away = () => {
      if (document.visibilityState === 'hidden') engine.away()
    }
    document.addEventListener('visibilitychange', away)
    return () => document.removeEventListener('visibilitychange', away)
  }, [engine])

  useEffect(() => {
    if (view.phase !== 'thinking') return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [view.phase])

  const count = view.items.length
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

  if (view.phase === 'login')
    return (
      <main className="talk talk-login">
        <form className="talk-card" onSubmit={login}>
          <div className="talk-brand">
            <Mark />
            <span>Сара</span>
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

  return (
    <main className={`talk talk-${view.phase}`}>
      <header className="talk-top">
        <div className="talk-brand">
          <Mark />
          <span>Сара</span>
        </div>
        <span className="talk-mono talk-status" aria-live="polite">
          {status}
        </span>
      </header>

      <div className="talk-feed" ref={feed}>
        {view.items.length === 0 && view.phase !== 'loading' && (
          <p className="talk-empty">{TALK_UI.empty}</p>
        )}
        {view.items.map((i) =>
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
              {i.who === 'sara' && (i.cards ?? 0) > 0 && (
                <p className="talk-cards">
                  {TALK_UI.cards} <a href="/inbox">{TALK_UI.inbox}</a>
                </p>
              )}
              <div className="talk-meta">
                <span className="talk-mono">{hhmm(i.at)}</span>
                {i.who === 'sara' && view.phase === 'idle' && (
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
              placeholder={TALK_UI.typeHere}
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
        <p className="talk-hint">{hint}</p>
      </footer>
    </main>
  )
}
