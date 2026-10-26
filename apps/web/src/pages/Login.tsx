import { useState } from 'react'
import { afterLogin, api, go } from '../api'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'

export function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <main className="mx-auto grid max-w-sm gap-4 px-4 py-10">
      <h1 className="font-display text-2xl">Вход в пульт</h1>
      <Card>
        <Input
          label="Пароль"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
        />
        <Button
          onClick={async () => {
            try {
              await api('/api/login', { password })
              go(afterLogin())
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          Войти
        </Button>
      </Card>
    </main>
  )
}
