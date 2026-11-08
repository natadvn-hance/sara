import { isTestOrder } from '@sara/shared'
import type { Db } from '../db/client'
import { TRIAL_SCOPE } from '../mind/trial'
import { getSetting } from '../settings/store'
import type { MindHit } from './types'

/**
 * Boris's voice from his skill «Голос Бориса» (07.11.2026) is tried on test orders first (his «да, но в тестовом
 * режиме»): its mind records have the scope `trial`, which a conversation sees only while the voice is on for it.
 */
export { TRIAL_SCOPE }

/** Records a turn with the new voice gets besides the usual ones: the form of his text and the voice's own rules. */
export const VOICE_ALWAYS = ['j-tone', 'j-voice']

/** Whether this conversation writes with the new voice: every one after «all», else only a test order's. */
export async function voiceOn(db: Db, chatId: string | null | undefined): Promise<boolean> {
  return (await getSetting(db, 'conv.voice')) === 'all' || isTestOrder(chatId)
}

/** The mind scopes a conversation reads: its direction's, and the trial one while the voice is on. */
export const scopesOf = (scope: string, on: boolean | undefined): string[] =>
  on ? [scope, TRIAL_SCOPE] : [scope]

/** The trial records go only to a conversation with the voice on. */
export const withoutTrial = (hits: MindHit[], on: boolean | undefined): MindHit[] =>
  on ? hits : hits.filter((h) => h.scope !== TRIAL_SCOPE)
