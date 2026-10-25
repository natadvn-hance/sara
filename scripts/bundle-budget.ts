// pnpm budget: the pult's first screen on a phone must stay small (NFR-PERF-2, M7 design section 12). Counts the
// gzip size of the scripts index.html loads at once (the entry and its preloads); screens loaded later do not count.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

export const LIMIT_BYTES = 180 * 1024

/** The scripts a browser loads with index.html, as paths inside dist. */
export function initialScripts(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script[^>]*\bsrc="\/([^"]+\.js)"/g)) if (m[1]) out.push(m[1])
  for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/([^"]+\.js)"/g))
    if (m[1]) out.push(m[1])
  return out
}

export async function checkBudget(
  dist: string,
  limitBytes = LIMIT_BYTES,
): Promise<{ ok: boolean; totalGzip: number; files: string[] }> {
  const files = initialScripts(await readFile(join(dist, 'index.html'), 'utf8'))
  let totalGzip = 0
  for (const f of files) totalGzip += gzipSync(await readFile(join(dist, f))).length
  return { ok: totalGzip <= limitBytes, totalGzip, files }
}

if (import.meta.main) {
  const dist = process.argv[2] ?? 'apps/web/dist'
  const r = await checkBudget(dist)
  const kb = (r.totalGzip / 1024).toFixed(1)
  if (r.ok) console.log(`Пульт: ${kb} КБ сжатого JavaScript на первый экран, предел 180 КБ.`)
  else {
    console.error(
      `Пульт тяжелее предела: ${kb} КБ сжатого JavaScript при пределе 180 КБ. Файлы: ${r.files.join(', ')}`,
    )
    process.exit(1)
  }
}
