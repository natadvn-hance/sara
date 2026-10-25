import {
  ExamScenario,
  MIND_ID_PREFIX,
  MIND_RECORD_ID,
  MindFrontmatter,
  type MindType,
} from '@sara/shared'
import { redact } from '../gateway/redact'
import { numbersIn } from '../school/lessons/edit'
import type { GuardInput } from '../school/types'
import { splitRecord } from './render'

/** The sections each type may have (M4 design 5.2); judgment is free text. */
const SECTIONS: Partial<Record<MindType, string[]>> = {
  knowledge: ['Факт', 'Когда говорить', 'Чего не говорить'],
  understanding: ['Признаки', 'Как отвечает Борис', 'Почему', 'Условия', 'Чего не делать'],
  speech: ['Форма', 'Словарь', 'Никогда не говорит', 'Прагматика', 'Темп'],
  example: ['Клиент', 'Борис', 'Контекст'],
}
/** Sources that carry Boris's own words: an example must rest on one of them. */
const BORIS_WORDS = ['edit:', 'say:', 'compare:', 'training:', 'history:']
/** Lessons whose `after` is Boris's own text, so a number in it is his. */
const BORIS_LESSONS = new Set(['edit', 'say', 'compare', 'training', 'interview'])

/** Boris's own name is in headings («## Борис») and in his words: never a client's name to look for. */
const OWNER = /^(?:борис|мноян)$/iu

/** The words of the clients' names to look for, without Boris's own (one client «Борис Петров» still hides «Петров»). */
export function clientWords(names: string[]): string[] {
  return [
    ...new Set(
      names.flatMap((n) => n.split(/\s+/)).filter((w) => w.trim().length > 1 && !OWNER.test(w)),
    ),
  ]
}

const KIND_WORDS: Record<string, string> = {
  phone: 'телефон',
  email: 'почта',
  link: 'ссылка',
  name: 'имя клиента',
}

/**
 * Why a file must not enter the mind, or null (M5 design 5.3, ADR-025). The writer asks it for every proposal
 * before writing; one refusal never stops the others.
 */
export function guardRecord(i: GuardInput): string | null {
  const c = i.change
  if (c.sources.length === 0) return 'нет источников'
  if (c.sources.some((s) => s.startsWith('sim:'))) return 'источник из сгенерированного диалога'
  // Nothing enters the mind without Boris's «да» on its lesson (ADR-025).
  if (i.lesson?.state !== 'yes') return 'Борис не сказал «да»'
  const names = clientWords(i.clientNames)
  if (c.file === 'scenario') {
    const s = ExamScenario.safeParse(c.scenario)
    if (!s.success) return `сценарий не по схеме: ${s.error.issues[0]?.message ?? ''}`
    // The file's name is the scenario's own id, which the schema keeps to letters, digits and hyphens.
    if (c.recordId !== s.data.id) return 'номер сценария не совпадает с файлом'
    if (c.action === 'create' && i.existingIds.has(c.recordId))
      return 'сценарий с таким номером уже есть'
    if (s.data.source.ref?.startsWith('sim:')) return 'сценарий из сгенерированного диалога'
    if (s.data.client_name && names.includes(s.data.client_name)) return 'в сценарии имя клиента'
    return privacy(i.text, names)
  }
  if (!MIND_RECORD_ID.test(c.recordId)) return 'номер записи не по правилу'
  const { front, sections } = splitRecord(i.text)
  const f = MindFrontmatter.safeParse(front)
  if (!f.success) return `поля записи не по схеме: ${f.error.issues[0]?.path.join('.') ?? ''}`
  const type = f.data.type
  if (!c.recordId.startsWith(MIND_ID_PREFIX[type])) return 'номер записи не той буквы'
  if (!i.scopes.includes(c.scope)) return `чужая область: ${c.scope}`
  const allowed = SECTIONS[type]
  if (allowed) {
    const bad = sections.map(([h]) => h).find((h) => !allowed.includes(h))
    if (bad) return `лишний раздел «${bad}»`
    if (c.section && !allowed.includes(c.section)) return `лишний раздел «${c.section}»`
  }
  if (c.action === 'create' && i.existingIds.has(c.recordId))
    return 'запись с таким номером уже есть'
  if (type === 'example') {
    if (i.lesson.sim) return 'урок из сгенерированной реплики не даёт образца'
    if (!c.sources.some((s) => BORIS_WORDS.some((w) => s.startsWith(w))))
      return 'у образца нет слов Бориса'
  }
  // What a reader of the record sees: its title, tags and section texts; never the headings or the field names.
  const said = [f.data.title, ...(f.data.tags ?? []), ...sections.map(([, t]) => t)].join('\n')
  if (type === 'knowledge' && (i.lesson.source === 'teacher' || i.lesson.source === 'interview')) {
    // The teacher's numbers must come from Boris's lessons; an interview record's, from his own answer.
    const words =
      i.lesson.source === 'interview'
        ? [i.lesson]
        : i.sourceLessons.filter((l) => BORIS_LESSONS.has(l.source))
    const his = new Set(words.flatMap((l) => numbersIn(l.after ?? '')))
    const foreign = numbersIn(said).find((n) => !his.has(n))
    if (foreign) return `число ${foreign} Борис не называл`
  }
  if (
    c.action === 'update' &&
    c.section === null &&
    c.baseVersion !== null &&
    f.data.version !== c.baseVersion + 1
  )
    return 'запись успели поменять'
  return privacy(said, names)
}

/** No phone, e-mail, link, @-name or the client's name (NFR-PRIV-2): the gateway's own patterns find them. */
function privacy(text: string, names: string[]): string | null {
  const r = redact(text, names)
  const found = Object.entries(r.counts)
    .filter(([, n]) => n > 0)
    .map(([k]) => KIND_WORDS[k] ?? k)
  return found.length > 0 ? `в записи ${found.join(', ')}` : null
}
