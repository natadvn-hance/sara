import { createHash } from 'node:crypto'
import type { ChatMessage } from '@sara/shared'
import type { FakeProfi } from '../fake/fakeProfi'
import type { ClientModel } from './model'
import { type Behaviour, type ChatPlan, moscowDay, type ScriptLine, type StandState } from './state'

/** A made-up client the model plays: the trainer's persona without its order (roles/trainer-client). */
export type StandPersona = {
  id: string
  archetype: string
  niche: string
  task: string
  mood: string
  style: string
  questions: string[]
}

/** How long a live client takes: to read our message, to answer first, to answer again, to type. */
export type Timing = {
  readMs: [number, number]
  firstReplyMs: [number, number]
  replyMs: [number, number]
  typingMs: number
}

/** The first answer comes after the series of the bid has gone (1-2 minutes, then 20-40 seconds). */
export const LIVE_TIMING: Timing = {
  readMs: [5_000, 15_000],
  firstReplyMs: [150_000, 200_000],
  replyMs: [30_000, 60_000],
  typingMs: 4_000,
}

/** The hard behaviour the model holds, in its own words; an ordinary client needs none. */
const HINTS: Partial<Record<Behaviour, string>> = {
  price:
    'Сразу спрашиваешь, сколько это стоит и за какой срок. Пока не услышишь цену или вилку, дальше разговор не ведёшь.',
  call: 'Тебе проще голосом: на второй-третьей реплике просишь созвониться. Если предлагают время, выбираешь один из вариантов; когда договорились, ends: call_agreed.',
}

export const LEAVE_TEXT = 'Добрый день! Спасибо за отклик, но мы уже выбрали другого исполнителя.'

export type ClientsDeps = {
  fake: FakeProfi
  state: StandState
  changed: () => void
  model: ClientModel
  personas: () => Promise<StandPersona[]>
  limits: { daily: number; perChat: number }
  timing: Timing
  now?: () => Date
  random?: () => number
}

export type Clients = {
  /** Our message landed in the chat (the bid or a message): the client reads it and, by its plan, answers. */
  heard(chatId: string, platformMessageId: string): void
  /** Boris writes as the client: what he types goes into the chat as the client's message. */
  write(chatId: string, text: string): Promise<void>
  plan(chatId: string): ChatPlan
  setPlan(
    chatId: string,
    p: { behaviour?: Behaviour; personaId?: string | null; script?: ScriptLine[] },
  ): ChatPlan
  /** After a restart: a chat whose last message is ours gets its answer again. */
  resume(): void
  /** Chats waiting for the client's answer now. */
  waiting(): string[]
  stop(): void
}

const between = (r: [number, number], random: () => number) =>
  Math.round(r[0] + (r[1] - r[0]) * random())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createClients(d: ClientsDeps): Clients {
  const random = d.random ?? Math.random
  const now = d.now ?? (() => new Date())
  const replyTimers = new Map<string, NodeJS.Timeout>()
  const otherTimers = new Set<NodeJS.Timeout>()

  const later = (ms: number, f: () => Promise<void>) => {
    const t = setTimeout(() => {
      otherTimers.delete(t)
      void f().catch((e) => console.error('stand client', e))
    }, ms)
    otherTimers.add(t)
  }

  function plan(chatId: string): ChatPlan {
    const known = d.state.plans[chatId]
    if (known) return known
    const fresh: ChatPlan = {
      behaviour: d.state.defaultBehaviour,
      personaId: null,
      script: [],
      replies: 0,
      ended: false,
      note: null,
    }
    d.state.plans[chatId] = fresh
    d.changed()
    return fresh
  }

  const chatOf = (chatId: string): ChatMessage[] =>
    d.fake.snapshot().chats.find((c) => c.chatId === chatId)?.messages ?? []

  async function say(chatId: string, text: string): Promise<void> {
    await d.fake.emitTyping(chatId).catch(() => {})
    await sleep(d.timing.typingMs)
    await d.fake.addChatMessage({ chatId, author: 'client', text })
  }

  async function persona(p: ChatPlan, chatId: string): Promise<StandPersona | null> {
    const all = await d.personas()
    const chosen =
      all.find((x) => x.id === p.personaId) ??
      all[createHash('sha256').update(chatId).digest().readUInt32BE(0) % Math.max(all.length, 1)]
    if (chosen && p.personaId !== chosen.id) p.personaId = chosen.id
    return chosen ?? null
  }

  async function answer(chatId: string): Promise<void> {
    replyTimers.delete(chatId)
    const p = plan(chatId)
    if (p.ended) return
    if (p.behaviour === 'manual' || p.behaviour === 'silent') return
    if (p.behaviour === 'leaves') {
      await say(chatId, LEAVE_TEXT)
      p.ended = true
      p.replies++
      d.fake.setOrderPage(chatId, { open: false })
      d.changed()
      return
    }
    if (p.behaviour === 'script') {
      const line = p.script.shift()
      if (!line) {
        p.ended = true
        d.changed()
        return
      }
      await say(chatId, line.text)
      p.replies++
      if (p.script.length === 0) p.ended = true
      d.changed()
      return
    }
    if (p.replies >= d.limits.perChat) {
      p.ended = true
      p.note = `клиент ответил уже ${p.replies} раз: дальше пиши за него сам`
      d.changed()
      return
    }
    const today = moscowDay(now())
    if (d.state.usage.day !== today) d.state.usage = { day: today, calls: 0 }
    if (d.state.usage.calls >= d.limits.daily) {
      p.note = `потолок модели-клиента на сегодня (${d.limits.daily}) исчерпан: пиши за клиента сам`
      d.changed()
      return
    }
    d.state.usage.calls++
    const order = d.fake.snapshot().orders.find((o) => o.order_id === chatId)
    const who = await persona(p, chatId)
    await d.fake.emitTyping(chatId).catch(() => {})
    const out = await d.model({
      persona: { ...who, name: order?.client_name || null },
      order: {
        title: order?.title ?? '',
        text: order?.text ?? '',
        budget_text: order?.budget_text ?? null,
      },
      behaviour: HINTS[p.behaviour] ?? null,
      dialog: chatOf(chatId)
        .filter((m) => m.author === 'client' || m.author === 'specialist')
        .slice(-20)
        .map((m) => ({ who: m.author === 'client' ? 'клиент' : 'исполнитель', text: m.text })),
    })
    if ('error' in out) {
      p.note = out.error
      d.changed()
      return
    }
    p.note = null
    await d.fake.addChatMessage({ chatId, author: 'client', text: out.text })
    p.replies++
    if (out.ends === 'left') p.ended = true
    d.changed()
  }

  function schedule(chatId: string): void {
    const p = plan(chatId)
    if (p.ended || p.behaviour === 'manual' || p.behaviour === 'silent') return
    const old = replyTimers.get(chatId)
    if (old) clearTimeout(old)
    const wrote = chatOf(chatId).some((m) => m.author === 'client')
    const wait = p.script[0]?.wait_s
    const ms =
      p.behaviour === 'script' && wait !== undefined
        ? wait * 1000
        : between(wrote ? d.timing.replyMs : d.timing.firstReplyMs, random)
    replyTimers.set(
      chatId,
      setTimeout(() => void answer(chatId).catch((e) => console.error('stand client', e)), ms),
    )
  }

  return {
    heard(chatId, platformMessageId) {
      const p = plan(chatId)
      if (p.behaviour !== 'manual')
        later(between(d.timing.readMs, random), () =>
          d.fake.emitRead(chatId, platformMessageId).catch(() => {}),
        )
      schedule(chatId)
    },
    async write(chatId, text) {
      const ours = chatOf(chatId)
        .filter((m) => m.author === 'specialist')
        .at(-1)
      if (ours) await d.fake.emitRead(chatId, ours.platform_message_id).catch(() => {})
      await d.fake.addChatMessage({ chatId, author: 'client', text })
    },
    plan,
    setPlan(chatId, x) {
      const p = plan(chatId)
      if (x.behaviour !== undefined) {
        p.behaviour = x.behaviour
        // A new behaviour starts the client over: the ceiling of one chat counts from here.
        p.ended = false
        p.note = null
        p.replies = 0
      }
      if (x.personaId !== undefined) p.personaId = x.personaId
      if (x.script !== undefined) p.script = [...x.script]
      d.changed()
      const last = chatOf(chatId).at(-1)
      if (last?.author === 'specialist') schedule(chatId)
      return p
    },
    resume() {
      for (const c of d.fake.snapshot().chats) {
        if (c.messages.at(-1)?.author === 'specialist') schedule(c.chatId)
      }
    },
    waiting: () => [...replyTimers.keys()],
    stop() {
      for (const t of replyTimers.values()) clearTimeout(t)
      for (const t of otherTimers) clearTimeout(t)
      replyTimers.clear()
      otherTimers.clear()
    },
  }
}
