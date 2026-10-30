import type { FileRead, OrderAttachment } from '@sara/shared'
import { strFromU8, unzipSync } from 'fflate'
import { decodeEntities } from './extract'
import { type Fetched, fetchPage } from './fetch'

/** The most documents read for one order, how big each may be, and how much of each the model is given. */
export const FILES_MAX = 3
export const FILE_BYTES = 6_000_000
export const FILE_CHARS = 4_000
const UNZIPPED_MAX = 20_000_000

/** The files of the order page live on Profi.ru's own hosts (profi.ru, cdn.profi.ru); no other host is asked. */
export const profiHost = (host: string) => host === 'profi.ru' || host.endsWith('.profi.ru')

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)
const squash = (s: string) =>
  s
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()

const entry = (zip: Record<string, Uint8Array>, name: string) => {
  const e = zip[name]
  return e ? strFromU8(e) : ''
}

/** DOCX: the paragraphs of word/document.xml. Only that one entry is unpacked, and never more than UNZIPPED_MAX. */
function docxText(bytes: Uint8Array): string {
  const zip = unzipSync(bytes, {
    filter: (f) => f.name === 'word/document.xml' && f.originalSize <= UNZIPPED_MAX,
  })
  return squash(
    decodeEntities(
      entry(zip, 'word/document.xml')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:(?:tab|br)\b[^>]*\/>/g, ' ')
        .replace(/<[^>]*>/g, ''),
    ),
  )
}

/** XLSX: the strings of the workbook (its text cells), one per line; formulas and numbers are not what a brief says. */
function xlsxText(bytes: Uint8Array): string {
  const zip = unzipSync(bytes, {
    filter: (f) => /^xl\/sharedStrings\.xml$/.test(f.name) && f.originalSize <= UNZIPPED_MAX,
  })
  const xml = entry(zip, 'xl/sharedStrings.xml')
  const items = [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeEntities((m[1] ?? '').replace(/<[^>]*>/g, '')).trim(),
  )
  return items.filter((x) => x !== '').join('\n')
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  const { text } = await extractText(pdf, { mergePages: true })
  return squash(Array.isArray(text) ? text.join('\n') : text)
}

const ext = (name: string) => /\.([a-z0-9]+)(?:$|\?)/i.exec(name)?.[1]?.toLowerCase() ?? ''

/** The text of a file by what it is (its first bytes, then its name); null: a kind Sara does not read. */
export async function fileText(bytes: Buffer, name: string): Promise<string | null> {
  const head = bytes.subarray(0, 5).toString('latin1')
  const kind = ext(name)
  if (head.startsWith('%PDF') || kind === 'pdf') return pdfText(bytes)
  if (head.startsWith('PK')) {
    if (kind === 'docx') return docxText(bytes)
    if (kind === 'xlsx') return xlsxText(bytes)
    return null
  }
  if (['txt', 'csv', 'md'].includes(kind)) return squash(new TextDecoder('utf-8').decode(bytes))
  return null
}

/** The address of a file as one the core may ask: an absolute https address, or one relative to profi.ru. */
const absolute = (url: string) =>
  url.startsWith('//') ? `https:${url}` : url.startsWith('/') ? `https://profi.ru${url}` : url

/**
 * Reads the documents attached to the order (Boris, 30.10.2026 evening): at most three, each downloaded from Profi.ru's
 * own hosts through the safe fetch and cut at 6 MB, the text taken out on the server. A file that does not come, is too
 * big or is of a kind not read is a note, not a failure. Pictures are only counted: reading them would need the model to
 * open files, which the roles never do. Never throws.
 */
export async function studyFiles(
  attachments: OrderAttachment[],
  o: { fetchPage?: (url: string) => Promise<Fetched> } = {},
): Promise<{ files: FileRead[]; texts: { name: string; text: string }[] }> {
  const get =
    o.fetchPage ??
    ((u: string) =>
      fetchPage(u, {
        raw: true,
        hostOk: profiHost,
        limits: { maxBytes: FILE_BYTES, timeoutMs: 15_000 },
      }))
  const files: FileRead[] = []
  const texts: { name: string; text: string }[] = []
  let documents = 0
  for (const a of attachments) {
    const note = (opened: boolean, error: string | null, chars = 0) =>
      files.push({ kind: a.kind, name: a.name || 'файл', opened, error, chars })
    if (a.kind === 'image') {
      note(false, 'not_read')
      continue
    }
    if (++documents > FILES_MAX) {
      note(false, 'not_read')
      continue
    }
    try {
      const got = await get(absolute(a.url))
      if (!got.ok) {
        note(false, got.error)
        continue
      }
      if (got.truncated) {
        note(false, 'too_big')
        continue
      }
      const text = await fileText(got.bytes ?? Buffer.from(got.html), a.name)
      if (text === null) note(false, 'unsupported')
      else if (text === '') note(false, 'empty')
      else {
        texts.push({ name: a.name, text: clip(text, FILE_CHARS) })
        note(true, null, Math.min(text.length, FILE_CHARS))
      }
    } catch {
      note(false, 'not_read')
    }
  }
  return { files, texts }
}
