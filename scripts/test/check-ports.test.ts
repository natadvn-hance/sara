import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { portViolations } from '../check-ports'

describe('production ports', () => {
  it('T4: only caddy publishes ports in the production compose', async () => {
    const text = await readFile(
      resolve(import.meta.dirname, '../../infra/compose.prod.yml'),
      'utf8',
    )
    expect(portViolations(text)).toEqual([])
  })

  it('T4: a service that publishes a port is reported', () => {
    const text =
      'services:\n  caddy:\n    ports: ["443:443"]\n  profi-node:\n    ports: ["7070:7070"]\n'
    expect(portViolations(text)).toEqual(['profi-node'])
  })
})
