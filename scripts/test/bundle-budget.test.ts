import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkBudget, initialScripts } from '../bundle-budget'

async function dist(files: Record<string, string | Buffer>, html: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'budget-'))
  await mkdir(join(dir, 'assets'))
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, 'assets', name), body)
  await writeFile(join(dir, 'index.html'), html)
  return dir
}

describe('bundle budget', () => {
  it('NFR-PERF-2: the budget fails on a bundle over 180 KB', async () => {
    const dir = await dist(
      { 'index-a.js': randomBytes(200 * 1024) },
      '<script type="module" crossorigin src="/assets/index-a.js"></script>',
    )
    const r = await checkBudget(dir)
    expect(r.ok).toBe(false)
    expect(r.files).toEqual(['assets/index-a.js'])
  })

  it('NFR-PERF-2: the entry and its preloads count, lazy screens do not', async () => {
    const html =
      '<script type="module" src="/assets/index-a.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor-b.js">'
    expect(initialScripts(html)).toEqual(['assets/index-a.js', 'assets/vendor-b.js'])
    const dir = await dist(
      {
        'index-a.js': 'x'.repeat(1000),
        'vendor-b.js': 'y',
        'Direction-c.js': randomBytes(300 * 1024),
      },
      html,
    )
    const r = await checkBudget(dir)
    expect(r.ok).toBe(true)
    expect(r.totalGzip).toBeLessThan(1000)
  })

  it('NFR-PERF-2: index.html blocks on no stylesheet from another site', async () => {
    const { readFile } = await import('node:fs/promises')
    const html = await readFile(join(import.meta.dirname, '../../apps/web/index.html'), 'utf8')
    const links = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0])
    const blocking = links.filter(
      (l) => /rel="stylesheet"/.test(l) && /href="https?:\/\//.test(l) && !/media="print"/.test(l),
    )
    expect(blocking).toEqual([])
  })
})
