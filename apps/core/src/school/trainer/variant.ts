import type { Dossier, MindSearch } from '../../conversation/types'
import type { Gateway } from '../../gateway/gateway'
import type { Priority } from '../../gateway/queue'
import type { SaraVariant } from '../types'

/** What Sara would answer, by the M4 turn engine, without sending (FR-TRAIN-4). Part C writes the body. */
export async function saraVariant(
  _d: { gateway: Gateway; mind: MindSearch },
  _i: { dossier: Dossier; names: string[]; now: Date; priority: Priority; exclude?: string[] },
): Promise<SaraVariant> {
  throw new Error('the trainer variant is not built')
}
