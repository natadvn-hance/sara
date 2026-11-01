import { createPrivateKey, generateKeyPairSync, sign, type webcrypto } from 'node:crypto'

type JsonWebKey = webcrypto.JsonWebKey

import type { NoticeKind } from '@sara/shared'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { notice, pushSubscription } from '../db/schema'
import { quietNow } from '../leads/cardFlow'
import type { SecretStore } from '../secrets/store'
import { getSetting } from '../settings/store'

/**
 * Web Push of the pult (pult v2 design 6): the phone and the computer ring with the same notices Telegram gets.
 * The push carries no data (nothing to encrypt, nothing of a client on the push service): the service worker asks
 * the core for the latest notice when it wakes. The VAPID key pair is made once and kept with the other secrets.
 */

const b64url = (b: Buffer) => b.toString('base64url')

type Vapid = { publicKey: string; jwk: JsonWebKey }

async function vapid(secrets: SecretStore): Promise<Vapid> {
  const raw = await secrets.ensure('push_vapid', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    return JSON.stringify(privateKey.export({ format: 'jwk' }))
  })
  const jwk = JSON.parse(raw) as JsonWebKey
  const x = Buffer.from(jwk.x ?? '', 'base64url')
  const y = Buffer.from(jwk.y ?? '', 'base64url')
  // The application server key the browser wants: the uncompressed point.
  return { publicKey: b64url(Buffer.concat([Buffer.from([4]), x, y])), jwk }
}

export async function pushPublicKey(secrets: SecretStore): Promise<string> {
  return (await vapid(secrets)).publicKey
}

/** The VAPID token for one push service (RFC 8292): ES256 over the service's origin, good for twelve hours. */
function vapidToken(v: Vapid, endpoint: string, subject: string, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  )
  const key = createPrivateKey({ key: v.jwk, format: 'jwk' })
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `${header}.${claims}.${b64url(sig)}`
}

export async function subscribe(
  db: Db,
  s: { endpoint: string; p256dh: string; auth: string; label: string | null },
): Promise<void> {
  await db
    .insert(pushSubscription)
    .values(s)
    .onConflictDoUpdate({
      target: pushSubscription.endpoint,
      set: { p256dh: s.p256dh, auth: s.auth, label: s.label, failedAt: null },
    })
}

export async function unsubscribe(db: Db, endpoint: string): Promise<void> {
  await db.delete(pushSubscription).where(eq(pushSubscription.endpoint, endpoint))
}

export type PushDeps = {
  db: Db
  secrets: SecretStore
  /** The pult's address, the contact of the VAPID token. */
  publicUrl: string
  fetch?: typeof fetch
}

/**
 * One notice rings on every subscribed browser, when its kind is on in «notify.push». Gone subscriptions (404,
 * 410) are dropped; other refusals are kept and marked. Never throws: a push must not hold up a card.
 */
export async function pushNotice(d: PushDeps, kind: NoticeKind): Promise<number> {
  try {
    const kinds = await getSetting(d.db, 'notify.push')
    if (kinds[kind] !== true) return 0
    const subs = await d.db.select().from(pushSubscription)
    if (subs.length === 0) return 0
    const v = await vapid(d.secrets)
    const urgent = kind === 'urgent' || kind === 'client'
    let sent = 0
    for (const s of subs) {
      try {
        const res = await (d.fetch ?? fetch)(s.endpoint, {
          method: 'POST',
          headers: {
            TTL: '3600',
            Urgency: urgent ? 'high' : 'normal',
            Authorization: `vapid t=${vapidToken(v, s.endpoint, d.publicUrl)}, k=${v.publicKey}`,
            'Content-Length': '0',
          },
          signal: AbortSignal.timeout(10_000),
        })
        if (res.status === 404 || res.status === 410) await unsubscribe(d.db, s.endpoint)
        else if (!res.ok)
          await d.db
            .update(pushSubscription)
            .set({ failedAt: new Date().toISOString() })
            .where(eq(pushSubscription.endpoint, s.endpoint))
        else sent++
      } catch (e) {
        console.error('push not sent', e instanceof Error ? e.message.slice(0, 200) : e)
      }
    }
    return sent
  } catch (e) {
    console.error('push skipped', e instanceof Error ? e.message.slice(0, 200) : e)
    return 0
  }
}

/** What the service worker shows when it wakes: the latest notice, silent in the quiet hours unless urgent. */
export async function latestForPush(
  db: Db,
  now = new Date(),
): Promise<{ title: string; body: string; link: string; silent: boolean; tag: string } | null> {
  const [n] = await db.select().from(notice).orderBy(desc(notice.createdAt)).limit(1)
  if (!n) return null
  return {
    title: n.title,
    body: n.body,
    link: n.link ?? '/notices',
    silent: n.kind !== 'urgent' && (await quietNow(db, now)),
    tag: n.taskId ?? n.id,
  }
}

export const _vapidTokenForTests = vapidToken
export const _vapidForTests = vapid
