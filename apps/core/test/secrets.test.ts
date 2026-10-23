import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSecretStore } from '../src/secrets/store'

describe('secret store', () => {
  it('NFR-SEC-1: secrets file is created with mode 600 and folder 700', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'sec-')), 'data')
    const store = createSecretStore(dir)
    await store.set('telegram_bot_token', 'x')
    expect((await stat(join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect(await store.get('telegram_bot_token')).toBe('x')
  })

  it('NFR-SEC-1: missing secret is null and ensure generates it once', async () => {
    const store = createSecretStore(await mkdtemp(join(tmpdir(), 'sec-')))
    expect(await store.get('claude_oauth_token')).toBeNull()
    const a = await store.ensure('session_secret', () => 'first')
    const b = await store.ensure('session_secret', () => 'second')
    expect([a, b]).toEqual(['first', 'first'])
  })
})
