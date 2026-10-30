// pnpm check:ports: only Caddy may publish ports in production, the test stand none at all (threat model T4).
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'

export function portViolations(composeYaml: string, allowed: string[] = ['caddy']): string[] {
  const doc = parse(composeYaml) as {
    services?: Record<string, { ports?: unknown[]; network_mode?: string }>
  }
  return Object.entries(doc.services ?? {})
    .filter(
      ([name, s]) =>
        !allowed.includes(name) && ((s.ports?.length ?? 0) > 0 || s.network_mode === 'host'),
    )
    .map(([name]) => name)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const read = (name: string) => readFile(resolve(import.meta.dirname, '../infra', name), 'utf8')
  const bad = portViolations(await read('compose.prod.yml'))
  if (bad.length > 0) {
    console.log(`Наружу открыты порты не только у caddy: ${bad.join(', ')}`)
    process.exit(1)
  }
  // The stand is reached only through the live Caddy (docs/ops/staging.md).
  const stand = portViolations(await read('compose.staging.yml'), [])
  if (stand.length > 0) {
    console.log(`Стенд открывает наружу порты: ${stand.join(', ')}`)
    process.exit(1)
  }
  console.log('Наружу открыт только caddy, у стенда ничего')
}
