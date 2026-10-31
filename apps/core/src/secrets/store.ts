import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type SecretName =
  | 'telegram_bot_token'
  | 'claude_oauth_token'
  | 'session_secret'
  /** Pult v2: the VAPID key pair of Web Push (JSON of two JWKs), made once on the server. */
  | 'push_vapid'

export type SecretStore = {
  get(name: SecretName): Promise<string | null>
  set(name: SecretName, value: string): Promise<void>
  ensure(name: SecretName, generate: () => string): Promise<string>
}

/** Secrets typed in the setup wizard live in one JSON file readable only by the owner. */
export function createSecretStore(dataDir: string): SecretStore {
  const file = join(dataDir, 'secrets.json')

  async function read(): Promise<Partial<Record<SecretName, string>>> {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return {}
    }
  }

  async function write(data: Partial<Record<SecretName, string>>): Promise<void> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    await chmod(dataDir, 0o700)
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, file)
  }

  return {
    async get(name) {
      return (await read())[name] ?? null
    },
    async set(name, value) {
      await write({ ...(await read()), [name]: value })
    },
    async ensure(name, generate) {
      const data = await read()
      const existing = data[name]
      if (existing) return existing
      const value = generate()
      await write({ ...data, [name]: value })
      return value
    },
  }
}
