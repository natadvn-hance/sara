import type {
  DirectionCase,
  DirectionRules,
  DirectionState,
  ReplyFormat,
  StepState,
} from '@sara/shared'
import { markAuthLost } from './app/auth'
import { telegramInitData } from './app/telegram'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The machine code of a refusal the screen reacts to (for example `stale`), when the API names one. */
    readonly code?: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> =
    body === undefined ? {} : { 'content-type': 'application/json' }
  // Inside Telegram the signed launch data goes with every request (M7 design, section 7).
  const initData = telegramInitData()
  if (initData) headers.authorization = `tma ${initData}`
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && initData) markAuthLost()
  if (!res.ok)
    throw new ApiError(
      res.status,
      (data as { error?: string }).error ?? 'Что-то пошло не так.',
      (data as { code?: string }).code,
    )
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

export type OnboardingView = {
  mode: 'new' | 'edit'
  basedOn: number | null
  step: number
  steps: Record<string, StepState>
  rules: DirectionRules | null
  changes: string[]
  changed: boolean
  broken?: boolean
}

export type RecomputeItem = {
  leadId: string
  title: string
  city: string
  before: { score: number; decision: 'show' | 'drop' }
  after: {
    score: number
    decision: 'show' | 'drop'
    reason: string
    stopFactor: string | null
    redFlags: string[]
    axes: { id: string; score: number; why: string }[]
  }
  boris: 'yes' | 'no' | null
}
export type RecomputeResult = {
  checked: number
  skipped: number
  changed: number
  toDrop: number
  toShow: number
  withBoris: number
  agreementBefore: number | null
  agreementAfter: number | null
  items: RecomputeItem[]
}
export type RunView = {
  id: string
  kind: 'recompute' | 'calibration'
  state: 'queued' | 'running' | 'marking' | 'done' | 'stopped' | 'failed'
  total: number
  done: number
  skipped: number
  stop_reason: string | null
  result: RecomputeResult | null
}
