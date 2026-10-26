import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ExamCase, ExamScenario } from '@sara/shared'
import { namesCase } from '../conversation/check/caseChecks'
import { isNewMoscowDay } from '../conversation/check/codeChecks'
import { NOT_NAMES } from '../conversation/check/phrases'
import { turnMessageIds } from '../conversation/dossier'
import { inMoscowHours } from '../conversation/time'
import type { CaseHit, Dossier, DossierMessage } from '../conversation/types'

/** The night of the exam: the hours the live rules call night (setting `conv.night`, default 23:00-8:00). */
const EXAM_NIGHT = { from: 23, to: 8 }

export type ScenarioError = { path: string; message: string }

export type LoadedScenarios = {
  scenarios: ExamScenario[]
  /** The hash of the content of the whole set: the exam compares a run only with a run of the same set. */
  setHash: string
  errors: ScenarioError[]
}

/** What is wrong with a scenario that parsed, or null: the rules of the data that the schema cannot say. */
function problemWith(s: ExamScenario, file: string): string | null {
  if (file !== `${s.id}.json`) return `имя файла ${file} не совпадает с номером ${s.id}`
  if (s.messages.at(-1)?.author !== 'client')
    return 'сценарий должен кончаться репликой клиента, иначе отвечать нечего'
  const times = s.messages.map((m) => Date.parse(m.at))
  if (times.some((t, i) => i > 0 && t < (times[i - 1] ?? 0)))
    return 'сообщения не по порядку времени'
  if (Date.parse(s.now) < (times.at(-1) ?? 0)) return 'время ответа раньше последнего сообщения'
  if (new Set(s.cases.map((c) => c.id)).size !== s.cases.length) return 'номера кейсов повторяются'
  if (s.expect.case === 'needed' && s.cases.length === 0)
    return 'ждём кейс, а в сценарии нет ни одного'
  if (s.tags.trap && !s.tags.hard) return 'ловушка с контактом должна быть трудным сценарием'
  return null
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Loads the exam scenarios of the folders (FR-TRAIN-8): every `*.json` file is one `ExamScenario`. A missing folder is
 * an empty one. A file that does not parse, repeats an id, or breaks a rule of the data is an error and is left out;
 * the caller decides whether a set with errors may run. The set hash follows the content, not the folders' order.
 */
export async function loadScenarios(dirs: string[]): Promise<LoadedScenarios> {
  const errors: ScenarioError[] = []
  const byId = new Map<string, { scenario: ExamScenario; path: string }>()
  for (const dir of dirs) {
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') errors.push({ path: dir, message: message(e) })
      continue
    }
    for (const name of names) {
      const path = join(dir, name)
      try {
        const parsed = ExamScenario.safeParse(JSON.parse(await readFile(path, 'utf8')))
        if (!parsed.success) {
          const first = parsed.error.issues[0]
          errors.push({
            path,
            message: `${first?.path.join('.') || 'сценарий'}: ${first?.message ?? 'не по схеме'}`,
          })
          continue
        }
        const s = parsed.data
        const problem = problemWith(s, name)
        if (problem) {
          errors.push({ path, message: problem })
          continue
        }
        const twin = byId.get(s.id)
        if (twin) {
          errors.push({ path, message: `номер ${s.id} уже есть в ${twin.path}` })
          continue
        }
        byId.set(s.id, { scenario: s, path })
      } catch (e) {
        errors.push({ path, message: message(e) })
      }
    }
  }
  const scenarios = [...byId.values()]
    .map((x) => x.scenario)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const setHash = createHash('sha256')
    .update(scenarios.map((s) => JSON.stringify(s)).join('\n'))
    .digest('hex')
    .slice(0, 16)
  return { scenarios, setHash, errors }
}

/** The hash of one scenario's content: a run keeps it, so the next run knows which scenarios have not changed. */
export function scenarioHash(s: ExamScenario): string {
  return createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 12)
}

/** A stable uuid for a scenario: the journal wants one where the live dossier has its conversation number. */
export function examUuid(id: string): string {
  const h = createHash('sha256').update(`exam:${id}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const sideOf = (author: ExamScenario['messages'][number]['author']): DossierMessage['side'] =>
  author === 'client' ? 'client' : author === 'system' ? 'system' : 'specialist'

/** A case of a scenario in the shape of the case search; the body has the sections of a record of the mind. */
export function caseHitOf(c: ExamCase): CaseHit {
  const body = [
    `# ${c.title}`,
    c.summary,
    ...(c.role ? [`## Роль и масштаб\n${c.role}`] : []),
    ...(c.result ? [`## Результат\n${c.result}`] : []),
    `## Как показывать клиенту\n${c.show_rules.map((r) => `- ${r}`).join('\n')}`,
  ].join('\n\n')
  return {
    id: c.id,
    type: 'knowledge',
    scope: 'shared',
    title: c.title,
    body,
    topic: null,
    tones: [],
    stages: [],
    exampleClient: null,
    exampleBoris: null,
    rank: 1,
    summary: c.summary,
    result: c.result,
    showRules: c.show_rules,
    nameOpen: c.name_open,
    numbersOpen: c.numbers_open,
  }
}

/**
 * A scenario built from history keeps a phone of the client as the tag `[телефон 1]`. The engine finds a phone in the
 * client's words by its figures (the call detector), so in the dossier the tag becomes a phone that is none: the turn
 * sees the request for a call it saw in work. The gateway hides it again before the model reads it.
 */
const PHONE_TAG = /\[телефон \d+\]/gu
const FAKE_PHONE = '+7 900 000-00-00'

/**
 * The dossier the turn engine reads for a scenario: what the live dossier would hold at that moment of the chat. The
 * flags of a new day and of the night follow `s.now`, the stage and the state are the scenario's, and the cases that
 * our side's earlier messages already told are the told cases.
 */
export function dossierFromScenario(s: ExamScenario, scope = 'shared'): Dossier {
  const messages: DossierMessage[] = s.messages.map((m, i) => ({
    author: m.author,
    side: sideOf(m.author),
    text: m.text.replace(PHONE_TAG, FAKE_PHONE),
    sentAt: m.at,
    platformMessageId: `${s.id}:${i + 1}`,
  }))
  const now = new Date(s.now)
  const lastOurs = messages.findLast((m) => m.side === 'specialist')
  const firstClient = messages.findIndex((m) => m.side === 'client')
  const opening = messages
    .slice(0, firstClient === -1 ? messages.length : firstClient)
    .filter((m) => m.side === 'specialist')
  const bid =
    s.bid ??
    (opening[0]
      ? { text: opening.map((m) => m.text).join('\n\n'), author: opening[0].author }
      : null)
  const ours = messages.filter((m) => m.side === 'specialist').map((m) => m.text)
  const o = s.order
  return {
    conversationId: examUuid(s.id),
    accountId: 'exam',
    scope,
    order:
      o.title || o.text
        ? {
            title: o.title,
            category: o.category,
            city: o.city,
            budgetText: o.budget_text,
            text: o.text,
          }
        : null,
    clientName: s.client_name,
    clientInfo: null,
    bid,
    messages,
    turnMessageIds: turnMessageIds(messages, null),
    borisNote: s.state.boris_note,
    stage: s.tags.stage,
    owner: s.state.owner,
    ownerReason: s.state.owner_reason,
    newDay: isNewMoscowDay(lastOurs?.sentAt ?? null, now),
    night: inMoscowHours(now, EXAM_NIGHT),
    lastOursAt: lastOurs?.sentAt ?? null,
    remindersSent: 0,
    toldCases: s.cases
      .filter((c) => ours.some((m) => namesCase(m, c.title)))
      .map((c) => ({ id: c.id, title: c.title })),
  }
}

/** A tag in place of a name, as the history builder leaves it: there is no name to hide. */
const IS_TAG = /^\[[^\]]+\]$/

/**
 * The names the gateway hides from the model for a scenario (ADR-016): the client's name, and the name our bid
 * greeted him with («<Имя>, здравствуйте» in the first message of our side), as the live turn finds them.
 */
export function examNames(s: ExamScenario): string[] {
  const first = s.messages.find((m) => sideOf(m.author) === 'specialist')
  const greeted = /^\s*([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)\s*,/u.exec(first?.text ?? '')?.[1]
  const folded = greeted?.toLowerCase().replace(/ё/g, 'е') ?? ''
  const names = [s.client_name, greeted && !NOT_NAMES.has(folded) ? greeted : null]
  return [
    ...new Map(
      names.flatMap((n) => (n && !IS_TAG.test(n) ? [[n.toLowerCase(), n] as const] : [])),
    ).values(),
  ]
}
