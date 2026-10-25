import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROLE = resolve(import.meta.dirname, '../../../roles/analyst')

describe('the Analyst role reads the client line of the order page', () => {
  it('FR-LEAD-6: the role says what «Клиент на площадке» is, where to use it and that it stays out of the text', async () => {
    const text = await readFile(join(ROLE, 'role.md'), 'utf8')
    expect(text).toContain('Клиент на площадке')
    expect(text).toMatch(/risks/)
    expect(text).toMatch(/condition/)
    expect(text).toMatch(/Не пиши в text[^\n]*(отзыв|клиент на площадке)/i)
  })

  it('FR-LEAD-6: the role version is raised, so a model call is traceable to this input', async () => {
    const meta = JSON.parse(await readFile(join(ROLE, 'meta.json'), 'utf8')) as { version: number }
    expect(meta.version).toBeGreaterThanOrEqual(2)
  })
})
