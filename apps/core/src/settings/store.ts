import { type Actor, newEventId, SETTINGS, type SettingKey, type SettingValue } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { setting, settingHistory } from '../db/schema'
import { appendEvent } from '../journal/journal'

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingValue<K>> {
  const [row] = await db.select().from(setting).where(eq(setting.key, key))
  if (!row) return SETTINGS[key].default as SettingValue<K>
  return SETTINGS[key].schema.parse(row.value) as SettingValue<K>
}

/** Changes one setting; the value is checked, the old one kept in history, the change journaled. */
export async function setSetting<K extends SettingKey>(
  db: Db,
  key: K,
  value: SettingValue<K>,
  changedBy: Actor,
): Promise<void> {
  const parsed = SETTINGS[key].schema.parse(value)
  const now = new Date().toISOString()
  await db.transaction(async (tx) => {
    await tx
      .insert(setting)
      .values({ key, value: parsed, changedBy, changedAt: now })
      .onConflictDoUpdate({
        target: setting.key,
        set: { value: parsed, changedBy, changedAt: now },
      })
    await tx.insert(settingHistory).values({ key, value: parsed, changedBy, changedAt: now })
    await appendEvent(tx, {
      type: 'setting.changed',
      v: 1,
      entity: { kind: 'setting', id: key },
      account_id: null,
      actor: changedBy,
      occurred_at: now,
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: { key },
    })
  })
}
