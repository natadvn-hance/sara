import { type InterlocutorOutput, LOCKED_TOPICS, type Topic } from '@sara/shared'
import { moscowHoursEnd } from './time'
import type { CheckIssue, Decision, Dossier, PolicySettings } from './types'

const LOCKED = new Set<Topic>(LOCKED_TOPICS)

export type DecideInput = {
  plan: {
    output: InterlocutorOutput | null
    issues: CheckIssue[]
    attempts: number
    /** The Checker read the reply; without it the code checks alone decide and the reply is a draft (design 5.6). */
    checkerRan: boolean
  }
  dossier: Dossier
  settings: PolicySettings
  now: Date
  /** The code found a call request or a phone in the client's words (callDetector). */
  callRequest: boolean
}

type Would = Decision['would']

/** What Sara would do herself, before shadow, pauses and the night (M4 design 5.8). */
function wouldDo(i: DecideInput): { would: Would; reason: string } {
  const out = i.plan.output
  if (i.dossier.owner === 'boris' && i.dossier.ownerReason === 'take')
    return { would: 'forward', reason: 'клиента ведёт Борис' }
  if (i.callRequest)
    return { would: 'call_boris', reason: 'клиент просит созвон, согласился на него или дал телефон' }
  if (!out) return { would: 'draft', reason: 'Собеседник не ответил' }
  if (out.move === 'none') return { would: 'nothing', reason: out.why || 'отвечать не нужно' }
  if (out.move === 'call_boris') return { would: 'call_boris', reason: out.why }
  if (LOCKED.has(out.topic) || i.settings.autonomy[out.topic] === 'call')
    return { would: 'call_boris', reason: `тема Бориса: ${out.topic}` }
  if (i.plan.issues.length > 0)
    return {
      would: 'draft',
      reason: `не прошло проверку: ${i.plan.issues.map((x) => x.detail).join('; ')}`,
    }
  if (out.move === 'reply' && !i.plan.checkerRan)
    return { would: 'draft', reason: 'без Проверяющего: он не ответил' }
  if (i.dossier.owner === 'boris')
    return { would: 'draft', reason: 'клиент Бориса: отправить по его «да»' }
  if (i.dossier.owner === 'paused') return { would: 'draft', reason: 'разговор на паузе' }
  if (i.settings.autonomy[out.topic] !== 'self')
    return { would: 'draft', reason: `по теме ${out.topic} пока черновик` }
  return { would: 'send', reason: out.why }
}

/**
 * The rules of a reply (FR-CONV-5, FR-CONV-8, FR-AUTO-2, FR-OPS-1): the model proposes, the code decides. Shadow turns
 * every action into a draft card that tells what Sara would have done herself.
 */
export function decide(i: DecideInput): Decision {
  const { would, reason } = wouldDo(i)
  const done = (
    action: Decision['action'],
    why = reason,
    holdUntil: string | null = null,
  ): Decision => ({
    action,
    would,
    reason: why,
    holdUntil,
  })
  if (would === 'nothing') return done('nothing')
  if (would === 'forward') return done('forward')
  if (i.settings.v1Writes) return done('draft', `режим тени; сама бы: ${reason}`)
  if (would === 'call_boris') return done('call_boris')
  if (would === 'draft') return done('draft')
  if (i.settings.accountPaused) return done('draft', 'аккаунт на паузе')
  if (!i.settings.outboundMessages) return done('draft', 'пауза «Пишет клиентам»')
  const end = i.plan.output?.urgent ? null : moscowHoursEnd(i.now, i.settings.night)
  if (end) return done('hold', 'ночь: отвечу утром', end.toISOString())
  return done('send')
}
