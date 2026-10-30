/**
 * Links a client is never given (Boris, 30.10.2026: «сайт нексум не рабочий, его отправлять не нужно»). The list is the
 * setting `links.blocked`: a site («nexum.su») or an address with its path («hance.pro/old»). A link of the list is
 * taken out of the mind's cases and sites before a model or a series sees it, out of the series Boris presses, and a
 * message of Sara's that still holds one is not sent.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** «https://www.nexum.su/» and «nexum.su» are the same entry «nexum.su». */
const entryOf = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')

/** A link of the entry, with or without the scheme and «www.», and with anything after it on the same address. */
function entryRe(entry: string): RegExp | null {
  const e = entryOf(entry)
  if (e.length < 3) return null
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}.-])(?:https?:\/\/)?(?:www\.)?${escapeRe(e)}(?![\p{L}\p{N}-])[^\s<>()«»"]*`,
    'giu',
  )
}

const patterns = (blocked: readonly string[]) =>
  blocked.map(entryRe).filter((r): r is RegExp => r !== null)

/** Whether the text holds a link of the list. */
export function hasBlockedLink(text: string, blocked: readonly string[]): boolean {
  return patterns(blocked).some((re) => {
    re.lastIndex = 0
    return re.test(text)
  })
}

/** The text with every link of the list taken out (for a record the program reads, never for a message to send). */
export function stripBlockedLinks(text: string, blocked: readonly string[]): string {
  return patterns(blocked).reduce((t, re) => t.replace(re, ''), text)
}

/**
 * A series without the links of the list: a line that holds one goes, and a message left with no lines goes too. The
 * other lines of a message keep their place.
 */
export function seriesWithoutBlocked(
  series: readonly string[],
  blocked: readonly string[],
): string[] {
  if (blocked.length === 0) return [...series]
  return series
    .map((m) =>
      m
        .split('\n')
        .filter((line) => !hasBlockedLink(line, blocked))
        .join('\n')
        .trim(),
    )
    .filter((m) => m !== '')
}
