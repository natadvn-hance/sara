import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTestApp, type TestApp } from './helpers/app'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'

const { db, close } = openTestDb()
afterAll(close)
let t: TestApp

beforeEach(async () => {
  await resetDb(db)
  t = await buildTestApp(db)
})
afterEach(() => t.close())

const post = (url: string, payload: object, cookie = true) =>
  t.app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie: t.cookie() } : {} })
const get = (url: string, cookie = true) =>
  t.app.inject({ method: 'GET', url, headers: cookie ? { cookie: t.cookie() } : {} })

async function until(cond: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}

describe('setup wizard API', () => {
  it('FR-SET-1: fresh system starts at the password step', async () => {
    expect((await get('/api/setup', false)).json()).toEqual({ next: 'password', completed: [] })
  })

  it('FR-SET-1: short password is refused with a reason', async () => {
    const r = await post('/api/setup/password', { password: 'коротко' }, false)
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('Пароль должен быть не короче 10 знаков.')
  })

  it('FR-SET-1: wizard resumes from the step where it stopped', async () => {
    expect(
      (await post('/api/setup/password', { password: 'длинныйпароль1' }, false)).statusCode,
    ).toBe(200)
    expect((await get('/api/setup')).json()).toEqual({ next: 'telegram', completed: ['password'] })
    expect(await countEvents(db, 'setup.step_completed')).toBe(1)
  })

  it('FR-SET-1: password cannot be set twice', async () => {
    await post('/api/setup/password', { password: 'длинныйпароль1' }, false)
    expect(
      (await post('/api/setup/password', { password: 'другойпароль22' }, false)).statusCode,
    ).toBe(409)
  })

  it('T11: setup routes after password need a session', async () => {
    await post('/api/setup/password', { password: 'длинныйпароль1' }, false)
    expect((await post('/api/setup/telegram', { token: t.tg.token }, false)).statusCode).toBe(401)
    expect((await get('/api/health', false)).statusCode).toBe(401)
  })

  it('FR-SET-1: login works with the right password only', async () => {
    await post('/api/setup/password', { password: 'длинныйпароль1' }, false)
    expect((await post('/api/login', { password: 'неверныйпароль' }, false)).statusCode).toBe(401)
    expect((await post('/api/login', { password: 'длинныйпароль1' }, false)).statusCode).toBe(200)
  })

  it('T11: more than five logins a minute are refused', async () => {
    await post('/api/setup/password', { password: 'длинныйпароль1' }, false)
    for (let i = 0; i < 5; i++) await post('/api/login', { password: 'неверныйпароль' }, false)
    const r = await post('/api/login', { password: 'длинныйпароль1' }, false)
    expect(r.statusCode).toBe(429)
    expect(r.json().error).toBe('Слишком много попыток. Подожди минуту.')
  })

  it('FR-SET-2: wrong format explains how to fix; token with spaces is trimmed', async () => {
    await post('/api/setup/password', { password: 'длинныйпароль1' }, false)
    const bad = await post('/api/setup/telegram', { token: 'abc' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/@BotFather целиком/)
    const ok = await post('/api/setup/telegram', { token: ` ${t.tg.token}\n` })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ botUsername: 'sara_dev_bot' })
  })

  it('FR-SET-2: token unknown to Telegram gives the BotFather hint', async () => {
    await post('/api/setup/password', { password: 'длинныйпароль1' }, false)
    const r = await post('/api/setup/telegram', {
      token: '123456789:AAunknownTokenThatTelegramDoesNotKnow',
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/командой \/token/)
  })

  it('FR-SET-2: telegram step completes when Boris writes /start', async () => {
    await post('/api/setup/password', { password: 'длинныйпароль1' }, false)
    await post('/api/setup/telegram', { token: t.tg.token })
    expect((await get('/api/setup/telegram/status')).json()).toEqual({
      bound: false,
      botUsername: 'sara_dev_bot',
    })
    t.tg.pushStart(111)
    await until(async () => (await get('/api/setup/telegram/status')).json().bound === true)
    expect((await get('/api/setup')).json()).toEqual({
      next: 'claude',
      completed: ['password', 'telegram'],
    })
  })

  it('FR-SET-3: claude step runs the probe and reports duration under 30 s', async () => {
    await post('/api/setup/password', { password: 'длинныйпароль1' }, false)
    const r = await post('/api/setup/claude', { token: 'claude-token' })
    expect(r.statusCode).toBe(200)
    expect(r.json().ok).toBe(true)
    expect(r.json().durationMs).toBeLessThan(30000)
    expect((await get('/api/setup')).json().completed).toContain('claude')
  })

  it('FR-SET-3: token refused by Claude gives the setup-token hint', async () => {
    await t.close()
    t = await buildTestApp(db, { FAKE_CLAUDE_MODE: 'auth_error' })
    await post('/api/setup/password', { password: 'длинныйпароль1' }, false)
    const r = await post('/api/setup/claude', { token: 'bad' })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/claude setup-token/)
  })
})
