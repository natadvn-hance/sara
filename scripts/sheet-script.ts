import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Boris's sheet script with a fresh secret (docs/ops/google-sheet.md): `pnpm sheet:script <file>` writes the script
 * to paste into Apps Script and prints the line for /opt/sara/.env. The secret lives only there and in his script.
 */

export const SCRIPT = resolve(import.meta.dirname, '../infra/sheet/sara-sheet.gs')
const PLACEHOLDER = '__SARA_SHEET_SECRET__'

export function fillScript(source: string, secret: string): string {
  if (!/^[0-9a-f]{32,}$/.test(secret)) throw new Error('secret must be 32+ hex characters')
  if (!source.includes(`'${PLACEHOLDER}'`)) throw new Error('the script has no secret placeholder')
  return source.replace(`'${PLACEHOLDER}'`, `'${secret}'`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2]
  if (!out) {
    console.error('Куда записать скрипт: pnpm sheet:script <файл>')
    process.exit(1)
  }
  const secret = randomBytes(24).toString('hex')
  await writeFile(out, fillScript(await readFile(SCRIPT, 'utf8'), secret), { mode: 0o600 })
  console.log(`SARA_SHEET_SECRET=${secret}`)
}
