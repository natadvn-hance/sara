import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FakeSnapshot } from '../fake/fakeProfi'

/** How the client of an order behaves in its chat (docs/ops/test-leads.md, «Клиенты»). */
export const BEHAVIOURS = [
  'answers',
  'price',
  'call',
  'silent',
  'leaves',
  'script',
  'manual',
] as const
export type Behaviour = (typeof BEHAVIOURS)[number]

export const BEHAVIOUR_TITLES: Record<Behaviour, string> = {
  answers: 'отвечает',
  price: 'просит цену',
  call: 'просит созвон',
  silent: 'молчит',
  leaves: 'уходит к другому',
  script: 'по сценарию',
  manual: 'пишу сам',
}

export type ScriptLine = { wait_s?: number; text: string }

/** The client of one order: chat and order share their number on the fake site. */
export type ChatPlan = {
  behaviour: Behaviour
  personaId: string | null
  /** Lines of a scripted client not said yet. */
  script: ScriptLine[]
  /** Replies the client wrote by itself (model or script). */
  replies: number
  /** The client left, or ran out of replies: it writes nothing more by itself. */
  ended: boolean
  /** Why the client stays quiet now, in words for the stand's page; null: nothing in the way. */
  note: string | null
}

export type StandState = {
  fake: FakeSnapshot | null
  plans: Record<string, ChatPlan>
  /** Where an order came from: `sample:<id>`, `real:<n>` or `inline`. */
  sources: Record<string, string>
  defaultBehaviour: Behaviour
  /** Model calls of the client today (Moscow day), for the daily ceiling. */
  usage: { day: string; calls: number }
  nextOrderNo: number
}

export const emptyState = (): StandState => ({
  fake: null,
  plans: {},
  sources: {},
  defaultBehaviour: 'answers',
  usage: { day: '', calls: 0 },
  nextOrderNo: 1,
})

export async function loadState(file: string): Promise<StandState> {
  try {
    return { ...emptyState(), ...JSON.parse(await readFile(file, 'utf8')) }
  } catch {
    return emptyState()
  }
}

/** Writes the state at most every `ms`, whole file at once, so a stop in the middle never leaves half a file. */
export function stateWriter(file: string, read: () => StandState, ms = 200) {
  let timer: NodeJS.Timeout | null = null
  let writing: Promise<void> = Promise.resolve()
  const write = async () => {
    timer = null
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(read()))
    await rename(tmp, file)
  }
  return {
    later() {
      if (timer) return
      timer = setTimeout(() => {
        writing = writing.then(write).catch((e) => console.error('stand state not saved', e))
      }, ms)
    },
    async now() {
      if (timer) clearTimeout(timer)
      writing = writing.then(write)
      await writing
    },
  }
}

/** The Moscow date, the day the ceiling of model calls counts by. */
export const moscowDay = (at: Date) =>
  new Date(at.getTime() + 3 * 3600_000).toISOString().slice(0, 10)
