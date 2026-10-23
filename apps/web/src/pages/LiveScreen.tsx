import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'

type Status = { alive: boolean; ipOk: boolean; balance_rub: number | null }

/** Boris logs in to Profi.ru on the server's own tab (ADR-023, FR-ACC-6). */
export function LiveScreenPage({ accountId }: { accountId: string }) {
  const [frame, setFrame] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [hidden, setHidden] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [lost, setLost] = useState(false)
  const ws = useRef<WebSocket | null>(null)

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(
      `${proto}://${window.location.host}/api/accounts/${accountId}/screen`,
    )
    socket.onmessage = (m) => {
      const f = JSON.parse(String(m.data)) as { frame: string }
      setFrame(f.frame)
    }
    socket.onclose = () => setLost(true)
    ws.current = socket
    return () => socket.close()
  }, [accountId])

  useEffect(() => {
    const timer = setInterval(async () => {
      setStatus(await api<Status>('/api/setup/profi/status').catch(() => null))
    }, 2000)
    return () => clearInterval(timer)
  }, [])

  const send = (input: object) => ws.current?.send(JSON.stringify(input))

  return (
    <main className="mx-auto grid max-w-3xl gap-3 px-4 py-4">
      <h1 className="font-display text-xl">Вход в Профи.ру</h1>
      <p className="text-sm text-muted">
        Нажимай прямо на картинку, как на экран. Пароль и код из СМС никуда не сохраняются.
      </p>
      {frame ? (
        <button
          type="button"
          className="block w-full cursor-pointer border-0 bg-transparent p-0"
          onClick={(e) => {
            // Fractions of the picture itself, not of the button around it.
            const r = (
              e.currentTarget.querySelector('img') ?? e.currentTarget
            ).getBoundingClientRect()
            send({
              t: 'click',
              x: (e.clientX - r.left) / r.width,
              y: (e.clientY - r.top) / r.height,
            })
          }}
        >
          <img
            alt="Экран вкладки Профи.ру"
            src={`data:image/jpeg;base64,${frame}`}
            className="block h-auto w-full rounded-md border border-border"
          />
        </button>
      ) : (
        <p>{lost ? 'Связь с экраном потеряна. Обнови страницу.' : 'Подключаюсь к экрану…'}</p>
      )}
      <Card>
        <Input
          label="Набрать текст"
          type={hidden ? 'password' : 'text'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
        />
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          Скрывать набираемое
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              send({ t: 'text', text })
              setText('')
            }}
          >
            Набрать
          </Button>
          <Button variant="secondary" onClick={() => send({ t: 'key', key: 'Backspace' })}>
            Стереть
          </Button>
          <Button variant="secondary" onClick={() => send({ t: 'key', key: 'Enter' })}>
            Ввод
          </Button>
        </div>
      </Card>
      {status?.alive && status.ipOk ? (
        <p role="status" className="text-ok">
          Аккаунт активен
        </p>
      ) : null}
      {status?.alive && !status.ipOk ? (
        <p role="alert" className="text-danger">
          Вход есть, но вкладка выходит в сеть не со своего IP. Аккаунт стоит, напиши разработке.
        </p>
      ) : null}
    </main>
  )
}
