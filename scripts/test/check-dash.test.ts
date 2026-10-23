import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findLongDashes } from '../check-dash'

const DASH = String.fromCharCode(0x2014)

describe('check-dash', () => {
  it('NFR-UX-1: reports file and line of a long dash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dash-'))
    await writeFile(join(dir, 'a.ts'), `const a = 1\nconst b = 'Привет ${DASH} мир'\n`)
    expect(await findLongDashes([dir])).toEqual([{ file: join(dir, 'a.ts'), line: 2 }])
  })

  it('NFR-UX-1: passes clean files and skips docs and node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dash-'))
    await mkdir(join(root, 'docs'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'docs', 'x.md'), `путь ${DASH} папка`)
    await writeFile(join(root, 'node_modules', 'y.js'), `x ${DASH} y`)
    await writeFile(join(root, 'src', 'b.ts'), 'const ok = 1\n')
    expect(await findLongDashes([root])).toEqual([])
  })
})
