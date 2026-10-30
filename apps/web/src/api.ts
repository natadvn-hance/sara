import type {
  DirectionCase,
  DirectionRules,
  DirectionState,
  ReplyFormat,
  StepState,
} from '@sara/shared'
import { navigate } from './app/router'

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

const TMA_KEY = 'sara.tma'

/**
 * The Mini App's entry (pult v2 design 7): Telegram puts its signed `initData` into the address; the pult keeps it
 * for the tab and sends it with every request, so the core lets Boris in without a password.
 */
export function initDataFromAddress(): string | null {
  try {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
    const fromHash = new URLSearchParams(hash).get('tgWebAppData')
    if (fromHash) {
      window.sessionStorage.setItem(TMA_KEY, fromHash)
      return fromHash
    }
    return window.sessionStorage.getItem(TMA_KEY)
  } catch {
    return null
  }
}

/** Opened inside Telegram: the address carried `tgWebAppData` once in this tab. */
export function inTelegram(): boolean {
  return initDataFromAddress() !== null
}

export function authHeaders(): Record<string, string> {
  const tma = initDataFromAddress()
  return tma ? { authorization: `tma ${tma}` } : {}
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...authHeaders(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
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

const AFTER_LOGIN = 'sara.afterLogin'

/** Where the login sends Boris back to: the page he was on when the pult asked for the password. */
export function afterLogin(): string {
  try {
    const p = window.sessionStorage.getItem(AFTER_LOGIN)
    window.sessionStorage.removeItem(AFTER_LOGIN)
    return p?.startsWith('/') && !p.startsWith('/login') ? p : '/'
  } catch {
    return '/'
  }
}

export function go(path: string): void {
  if (path === '/login' && !window.location.pathname.startsWith('/login')) {
    try {
      window.sessionStorage.setItem(AFTER_LOGIN, window.location.pathname)
    } catch {}
  }
  navigate(path)
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
  calibration: CalibrationSummary | null
  gatePassed: boolean
  directionState: DirectionState
  /** The profile as the confirmed steps 5-7 would make it, what that changes, and what contradicts what. */
  profile: { speed: 'normal' | 'fast'; reply_format: ReplyFormat | null; cases: DirectionCase[] }
  profileChanges: string[]
  contradictions: {
    id: string
    text: string
    fix: { label: string; patch: { speed?: 'normal' | 'fast' } } | null
  }[]
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
export type CalibrationSummary = {
  runId: string
  state: string
  agreement: number | null
  decisive: number
  passed: boolean
  reliable: boolean
}
export type CalibrationItem = {
  leadId: string
  title: string
  city: string
  budget: string | null
  text: string
  mark: 'yes' | 'no' | 'unsure' | null
}
export type CalibrationMiss = {
  leadId: string
  title: string
  city: string
  text: string
  kind: 'sara_no_boris_yes' | 'sara_yes_boris_no'
  score: number
  reason: string
  axes: { id: string; score: number; why: string }[]
  stopFactor: string | null
  redFlags: string[]
  note: string | null
}
export type CalibrationResult = {
  decisive: number
  unsure: number
  agreement: number | null
  reliable: boolean
  passed: boolean
  threshold: number
  misses: CalibrationMiss[]
  thresholdHint: { from: number; to: number; before: number; after: number } | null
}
export type Advice = { summary: string; why: string; lines: string[] }
export type RunView = {
  id: string
  kind: 'recompute' | 'calibration'
  state: 'queued' | 'running' | 'marking' | 'done' | 'stopped' | 'failed'
  total: number
  done: number
  skipped: number
  stop_reason: string | null
  result: RecomputeResult | null
  calibration: {
    marked: number
    items: CalibrationItem[]
    result: CalibrationResult | null
    advice: Advice | null
    stale: boolean
  } | null
}
