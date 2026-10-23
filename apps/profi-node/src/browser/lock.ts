import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProfiToolError } from '../mcp/server'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * One browser per profile (ADR-003): a second browser on the same session killed the login on 29.09.2026.
 * Returns the release function; a lock left by a dead process is taken over.
 */
export async function acquireProfileLock(dir: string): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, '.sara-lock')
  const held = Number((await readFile(file, 'utf8').catch(() => '')).trim())
  if (held && alive(held)) {
    throw new ProfiToolError(
      'INTERNAL',
      `SECOND_BROWSER: profile ${dir} is already open in process ${held}`,
    )
  }
  await writeFile(file, String(process.pid), { mode: 0o600 })
  return async () => {
    await rm(file, { force: true })
  }
}
