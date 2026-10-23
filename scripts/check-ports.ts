// pnpm check:ports: only Caddy may publish ports in production (threat model T4).
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'

export function portViolations(composeYaml: string): string[] {
  const doc = parse(composeYaml) as {
    services?: Record<string, { ports?: unknown[]; network_mode?: string }>
  }
  return Object.entries(doc.services ?? {})
    .filter(
      ([name, s]) => name !== 'caddy' && ((s.ports?.length ?? 0) > 0 || s.network_mode === 'host'),
    )
    .map(([name]) => name)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = resolve(import.meta.dirname, '../infra/compose.prod.yml')
  const bad = portViolations(await readFile(file, 'utf8'))
  if (bad.length > 0) {
    console.log(`Наружу открыты порты не только у caddy: ${bad.join(', ')}`)
    process.exit(1)
  }
  console.log('Наружу открыт только caddy')
}
