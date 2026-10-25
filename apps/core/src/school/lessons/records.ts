import type { ConvStage, MindType, Tone, Topic } from '@sara/shared'
import { redact } from '../../gateway/redact'
import type { ProposalKind } from '../../mind/proposals'
import type { MindChange } from '../types'

const DASHES = /[\u2013\u2014]/g
/** Splits two texts hidden in one pass, so one client's name gets one tag in both. */
const SPLIT = '\n<<<раздел>>>\n'

/** Where a new record of each type lives (M4 design 5.2); an update keeps the record's own file. */
const FOLDER: Record<MindType, string> = {
  knowledge: 'knowledge',
  understanding: 'understanding',
  speech: 'speech',
  judgment: 'judgment',
  example: 'speech/examples',
}

/** The client's name and contacts become the gateway's tags, the same tag in every part (NFR-PRIV-2). */
export function hideClient(parts: string[], names: string[]): string[] {
  return redact(parts.join(SPLIT), names).text.split(SPLIT)
}

const scopeDir = (scope: string) => (scope === 'shared' ? 'shared' : `directions/${scope}`)

/**
 * The proposal's own path, unique in core.mind_proposal: under `mind/proposals/` like M4's, and with `.l<n>` unless
 * the record id already holds the lesson's number (two drafts of one record must not collide). The file the writer
 * writes is worked out from the record, not from this path.
 */
export function proposalPath(c: MindChange, n: number): string {
  const unique = c.recordId.endsWith(`-${n}`) ? '' : `.l${n}`
  if (c.file === 'scenario') return `exam/scenarios/${c.recordId}${unique}.json`
  return `mind/proposals/${scopeDir(c.scope)}/${FOLDER[c.type ?? 'knowledge']}/${c.recordId}${unique}.md`
}

export function proposalKind(c: MindChange): ProposalKind {
  return c.file === 'scenario' ? 'scenario' : (c.type ?? 'other')
}

/** What the card shows of a change before it is written: the title and the sections. */
export function previewOf(c: MindChange): string {
  if (c.file === 'scenario') return JSON.stringify(c.scenario, null, 2)
  const head = c.fields.title ? `# ${c.fields.title}\n\n` : ''
  const body = Object.entries(c.sections)
    .map(([h, t]) => `## ${h}\n${t}`)
    .join('\n\n')
  return `${head}${body}\n`
}

/** A speech example from Boris's own reply (M5 design 5.1): the code builds it, the model never writes the file. */
export function exampleChange(l: {
  scope: string
  topic: Topic
  tone: Tone
  stage: ConvStage | null
  clientText: string
  borisText: string
  insight: string
  source: string
  names: string[]
}): MindChange {
  // The insight too: the model may have named the client or copied a contact (NFR-PRIV-2).
  const [client = '', boris = '', insight = ''] = hideClient(
    [l.clientText, l.borisText, l.insight],
    l.names,
  )
  const title = insight.trim().slice(0, 80) || 'Ответ Бориса'
  return {
    file: 'record',
    action: 'create',
    recordId: 'e-l-{n}',
    type: 'example',
    scope: l.scope,
    fields: {
      title,
      topic: l.topic,
      tones: [l.tone],
      ...(l.stage ? { stages: [l.stage] } : {}),
    },
    sections: {
      Клиент: client.trim(),
      Борис: boris.replace(DASHES, '-').trim(),
      Контекст: insight.trim(),
    },
    scenario: null,
    section: null,
    baseVersion: null,
    sources: [l.source],
  }
}

/** A knowledge record from Boris's interview answer (M5 design 5.9). */
export function knowledgeChange(l: {
  scope: string
  topic: Topic
  fact: { title: string; fact: string; when: string; not_say: string }
  source: string
  names: string[]
}): MindChange {
  const [title = '', fact = '', when = '', notSay = ''] = hideClient(
    [l.fact.title, l.fact.fact, l.fact.when, l.fact.not_say],
    l.names,
  ).map((t) => t.replace(DASHES, '-').trim())
  return {
    file: 'record',
    action: 'create',
    recordId: 'k-i-{n}',
    type: 'knowledge',
    scope: l.scope,
    fields: { title: title.slice(0, 120), topic: l.topic },
    sections: { Факт: fact, 'Когда говорить': when, 'Чего не говорить': notSay },
    scenario: null,
    section: null,
    baseVersion: null,
    sources: [l.source],
  }
}
