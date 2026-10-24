import type { DirectionCase, DirectionRules, DirectionState, ReplyFormat } from '@sara/shared'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new ApiError(res.status, (data as { error?: string }).error ?? 'Что-то пошло не так.')
  return data as T
}

export type SetupState = {
  next: 'password' | 'telegram' | 'claude' | 'profi' | 'done'
  completed: string[]
}
export type HealthCheck = {
  id: string
  ok: boolean
  title: string
  detail: string
  fix: string | null
}

export function go(path: string): void {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export type DirectionVersionRow = {
  version: number
  createdAt: string
  createdBy: 'seed' | 'boris'
  reason: string
  active: boolean
}
export type DirectionView = {
  account: { id: string; title: string }
  state: DirectionState
  active: { version: number; rules: DirectionRules }
  versions: DirectionVersionRow[]
  profile: {
    speed: 'normal' | 'fast'
    reply_format: ReplyFormat | null
    cases: DirectionCase[]
    version: number
  }
  onboarding: { open: boolean; step: number } | null
}
