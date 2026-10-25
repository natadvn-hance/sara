import type { MindFrontmatter, MindType } from '@sara/shared'
import { parse } from 'yaml'
import type { MindChange } from '../school/types'

/** Where a new record of each type lives (M4 design 5.2); an existing record keeps its own file. */
const FOLDER: Record<MindType, string> = {
  knowledge: 'knowledge',
  understanding: 'understanding',
  speech: 'speech',
  judgment: 'judgment',
  example: 'speech/examples',
}

/** The fields at the top in M4's order. */
const ORDER = [
  'id',
  'type',
  'scope',
  'status',
  'version',
  'sources',
  'valid_from',
  'valid_to',
  'title',
  'tags',
  'topic',
  'tones',
  'stages',
  'examples',
] as const

/** A record's text split into its fields and its `## ` sections. */
export function splitRecord(text: string): {
  front: Record<string, unknown>
  sections: [string, string][]
} {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  const front = (m ? (parse(m[1] ?? '') as Record<string, unknown>) : {}) ?? {}
  const body = m ? (m[2] ?? '') : text
  const sections: [string, string][] = []
  for (const part of body.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n')
    const head = (nl < 0 ? part : part.slice(0, nl)).trim()
    sections.push([head, nl < 0 ? '' : part.slice(nl + 1).trim()])
  }
  return { front, sections }
}

/** YAML that every reader takes the same way: strings in double quotes, lists inline. */
const yamlValue = (v: unknown): string =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? `[${v.map(yamlValue).join(', ')}]`
      : typeof v === 'number'
        ? String(v)
        : JSON.stringify(String(v))

export function writeRecord(front: Record<string, unknown>, sections: [string, string][]): string {
  const lines = ORDER.filter((k) => front[k] !== undefined).map(
    (k) => `${k}: ${yamlValue(front[k])}`,
  )
  const body = sections.map(([h, t]) => `## ${h}\n${t}`).join('\n\n')
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`
}

const scopeDir = (scope: string) => (scope === 'shared' ? 'shared' : `directions/${scope}`)

/** The file of a new record: worked out from the type, the scope and the id, never from a model's words. */
export function newTarget(c: MindChange): string {
  if (c.file === 'scenario') return `exam/scenarios/${c.recordId}.json`
  return `mind/${scopeDir(c.scope)}/${FOLDER[c.type ?? 'knowledge']}/${c.recordId}.md`
}

/**
 * The file a change makes (M5 design 5.3): a new confirmed record (version 1), the next version of the current one
 * (only its section, when the change names one), or the current one marked outdated. A section of a record that
 * does not exist yet, or is only a proposal, starts a confirmed record with that section.
 */
export function renderRecord(
  c: MindChange,
  current: { version: number; text: string; status: string; path?: string } | null,
  today: string,
): { target: string; text: string } {
  if (c.file === 'scenario') {
    if (!c.scenario) throw new Error('a scenario change without the scenario')
    return { target: newTarget(c), text: `${JSON.stringify(c.scenario, null, 2)}\n` }
  }
  const live = current && current.status !== 'proposal' ? current : null
  const target = live?.path ?? newTarget(c)
  const old = live ? splitRecord(live.text) : { front: {}, sections: [] as [string, string][] }
  const sources = [
    ...new Set([...((old.front.sources as string[] | undefined) ?? []), ...c.sources]),
  ]
  const front: Partial<MindFrontmatter> & Record<string, unknown> = {
    ...old.front,
    ...Object.fromEntries(Object.entries(c.fields).filter(([, v]) => v !== undefined)),
    id: c.recordId,
    type: c.type ?? (old.front.type as MindType),
    scope: c.scope,
    status: c.action === 'outdate' ? 'outdated' : 'confirmed',
    version: live ? live.version + 1 : 1,
    sources,
    valid_from: c.action === 'outdate' ? String(old.front.valid_from ?? today) : today,
    valid_to: c.action === 'outdate' ? today : null,
  }
  let sections: [string, string][]
  if (c.action === 'outdate') sections = old.sections
  else if (c.section) {
    const text = c.sections[c.section] ?? ''
    const at = old.sections.findIndex(([h]) => h === c.section)
    sections =
      at < 0
        ? [...old.sections, [c.section, text]]
        : old.sections.map((s, i) => (i === at ? [s[0], text] : s))
  } else sections = Object.entries(c.sections)
  return { target, text: writeRecord(front, sections) }
}

/** An M4 proposal file made confirmed as it is (the content was written whole, without a change). */
export function confirmContent(content: string, today: string): string {
  const { front, sections } = splitRecord(content)
  return writeRecord(
    { ...front, status: 'confirmed', valid_from: front.valid_from ?? today },
    sections,
  )
}
