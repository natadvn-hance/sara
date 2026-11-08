import { authHeaders } from '../api'
import type { TalkState } from './logic'

/** Who answers in the app (ADR-028): Lora by default, Sara on call. */
export type Agent = 'lora' | 'sara'

/** The core's answers to the voice app (apps/core/src/talk/routes.ts). */
export type SaidReply = { text: string; buttons: boolean }
export type Sent = {
  heard: string | null
  talk: string | null
  reply: SaidReply | null
  /** Boris called the other one: she answers from now on. */
  switch?: Agent
}
export type Line = { author: 'boris' | 'sara' | 'lora'; text: string; at: string }

export class SignedOut extends Error {}

/** A refusal of the core, with its code: the app shows the code, so «Нет связи» is never a mystery. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A short name of what went wrong, for the small print under «Нет связи». */
export function failureOf(e: unknown): string {
  if (e instanceof HttpError) return `код ${e.status}`
  if (e instanceof Error) return e.name === 'Error' ? e.message.slice(0, 60) : e.name
  return 'неизвестно'
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (res.status === 401) throw new SignedOut()
  return res
}

const json = async <T>(res: Response): Promise<T> => {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok && res.status !== 404) throw new HttpError(res.status, data.error ?? 'Нет связи.')
  return data
}

export const talkApi = {
  history: async (agent: Agent) =>
    (await json<{ lines: Line[] }>(await call(`/api/talk/history?agent=${agent}`))).lines,
  login: async (password: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'same-origin',
    })
    if (!res.ok)
      throw new Error(
        ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Не вышло войти.',
      )
  },
  sendVoice: async (audio: Blob, agent: Agent, talk: string) =>
    json<Sent>(
      await call(`/api/talk?agent=${agent}&talk=${talk}`, {
        method: 'POST',
        headers: { 'content-type': audio.type || 'audio/mp4' },
        body: audio,
      }),
    ),
  sendText: async (text: string, agent: Agent) =>
    json<Sent>(
      await call(`/api/talk?agent=${agent}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    ),
  answer: async (talk: string) => json<TalkState>(await call(`/api/talk/${talk}`)),
  /** Her voice for these words, or null: then the phone's own voice says them. */
  speak: async (text: string, agent: Agent): Promise<Blob | null> => {
    const res = await call('/api/talk/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, agent }),
    })
    return res.ok ? res.blob() : null
  },
  warm: () => void call('/api/talk/warm', { method: 'POST' }).catch(() => {}),
  /** The voice woken at the start, which also says whether Boris is signed in (SignedOut otherwise). */
  start: async () => {
    await call('/api/talk/warm', { method: 'POST' })
  },
}
