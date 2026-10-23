import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError, api, go, type SetupState } from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'

function useAction() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(f: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await f()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return go('/login')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, run }
}

function PasswordStep({ done }: { done: () => void }) {
  const [password, setPassword] = useState('')
  const a = useAction()
  return (
    <Card>
      <h2 className="font-display text-lg">Шаг 1. Пароль владельца</h2>
      <p>Пароль нужен, чтобы в пульт входил только ты. Не меньше 10 знаков.</p>
      <Input
        label="Пароль"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={a.error}
      />
      <Button
        disabled={a.busy}
        onClick={() =>
          a.run(async () => {
            await api('/api/setup/password', { password })
            done()
          })
        }
      >
        Сохранить пароль
      </Button>
    </Card>
  )
}

function TelegramStep({ done }: { done: () => void }) {
  const [token, setToken] = useState('')
  const [bot, setBot] = useState<string | null>(null)
  const a = useAction()
  useEffect(() => {
    if (!bot) return
    const timer = setInterval(async () => {
      const s = await api<{ bound: boolean }>('/api/setup/telegram/status').catch(() => ({
        bound: false,
      }))
      if (s.bound) done()
    }, 2000)
    return () => clearInterval(timer)
  }, [bot, done])
  return (
    <Card>
      <h2 className="font-display text-lg">Шаг 2. Telegram</h2>
      <ol className="grid list-decimal gap-1 pl-5">
        <li>Открой @BotFather и отправь /newbot.</li>
        <li>Придумай имя и адрес бота, адрес должен заканчиваться на bot.</li>
        <li>Скопируй токен из ответа и вставь сюда.</li>
      </ol>
      <Input
        label="Токен бота"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        error={a.error}
        autoComplete="off"
      />
      <Button
        disabled={a.busy}
        onClick={() =>
          a.run(async () => {
            const r = await api<{ botUsername: string }>('/api/setup/telegram', { token })
            setBot(r.botUsername)
          })
        }
      >
        Проверить токен
      </Button>
      {bot ? <p role="status">{`Бот @${bot} найден. Напиши ему /start.`}</p> : null}
    </Card>
  )
}

function ClaudeStep({ done }: { done: () => void }) {
  const [token, setToken] = useState('')
  const a = useAction()
  const saved = useQuery({
    queryKey: ['claude-token'],
    queryFn: () => api<{ tokenSaved: boolean }>('/api/setup/claude'),
  })
  const command = 'claude setup-token'
  return (
    <Card>
      <h2 className="font-display text-lg">Шаг 3. Claude</h2>
      <p>На Маке открой Терминал и выполни команду:</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 rounded-md border border-border px-3 py-2 font-mono">
          {command}
        </code>
        <Button
          variant="secondary"
          onClick={() => navigator.clipboard?.writeText(command).catch(() => {})}
        >
          Скопировать
        </Button>
      </div>
      <p>
        {saved.data?.tokenSaved
          ? 'Токен Claude уже сохранён на этом Маке. Можно сразу нажать «Проверить Claude» или вставить новый.'
          : 'Вставь токен, который она покажет.'}
      </p>
      <Input
        label="Токен Claude"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        error={a.error}
        autoComplete="off"
      />
      <Button
        disabled={a.busy}
        onClick={() =>
          a.run(async () => {
            await api('/api/setup/claude', { token })
            done()
          })
        }
      >
        Проверить Claude
      </Button>
      {a.busy ? <p role="status">Проверяю, это займёт до 30 секунд</p> : null}
    </Card>
  )
}

function ProfiStep({ done }: { done: () => void }) {
  const a = useAction()
  return (
    <Card>
      <h2 className="font-display text-lg">Шаг 4. Профи.ру</h2>
      <p>
        Сара входит в твой аккаунт Профи.ру на своём сервере. Ты входишь сам на живом экране:
        телефон и код из СМС, как на сайте. Можно с телефона.
      </p>
      <a
        className="text-accent underline"
        href="/accounts/hance-marketing/login"
        onClick={(e) => {
          e.preventDefault()
          go('/accounts/hance-marketing/login')
        }}
      >
        Открыть живой экран
      </a>
      <Button
        variant="secondary"
        disabled={a.busy}
        onClick={() =>
          a.run(async () => {
            await api('/api/setup/profi/later', {})
            done()
          })
        }
      >
        Сделать позже
      </Button>
    </Card>
  )
}

export function SetupPage() {
  const qc = useQueryClient()
  const state = useQuery({ queryKey: ['setup'], queryFn: () => api<SetupState>('/api/setup') })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['setup'] })
  if (!state.data) return <p>Загружаю мастер запуска…</p>
  const { next, completed } = state.data
  return (
    <main className="mx-auto grid max-w-xl gap-4 px-4 py-6">
      <h1 className="font-display text-2xl">Мастер запуска</h1>
      <p className="text-muted">{`Готово шагов: ${completed.length} из 4`}</p>
      {next === 'password' ? <PasswordStep done={refresh} /> : null}
      {next === 'telegram' ? <TelegramStep done={refresh} /> : null}
      {next === 'claude' ? <ClaudeStep done={refresh} /> : null}
      {next === 'profi' ? <ProfiStep done={refresh} /> : null}
      {next === 'done' ? (
        <Card>
          <p className="text-lg">Готово. Сара на связи.</p>
          <a
            className="text-accent underline"
            href="/health"
            onClick={(e) => {
              e.preventDefault()
              go('/health')
            }}
          >
            Состояние системы
          </a>
        </Card>
      ) : null}
    </main>
  )
}
