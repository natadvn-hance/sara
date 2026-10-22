import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkMind } from '../mind-check'

const FIX = resolve(import.meta.dirname, 'fixtures/mind')

describe('mind check', () => {
  it('FR-MIND-1: valid record passes', async () => {
    expect(await checkMind(join(FIX, 'good'))).toEqual([])
  })

  it('FR-MIND-1: wrong status names the file and the field', async () => {
    expect(await checkMind(join(FIX, 'bad'))).toEqual([
      { file: join(FIX, 'bad', 'price.md'), field: 'status', message: expect.any(String) },
    ])
  })

  it('FR-MIND-1: a file without fields at the top is reported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mind-'))
    await writeFile(join(dir, 'plain.md'), 'Просто текст\n')
    expect(await checkMind(dir)).toEqual([
      { file: join(dir, 'plain.md'), field: 'frontmatter', message: expect.any(String) },
    ])
  })
})
