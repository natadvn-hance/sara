import { createPublicKey, verify } from 'node:crypto'
import { type NoticeKind, newEventId } from '@sara/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkInitData, initDataHash } from '../../src/auth/telegramAuth'
import { notice, ownerAuth, pushSubscription, setting } from '../../src/db/schema'
import { withNoticeLog } from '../../src/notify/center'
import type { Notifier } from '../../src/notify/notifier'
import {
  _vapidForTests,
  _vapidTokenForTests,
  latestForPush,
  pushNotice,
  subscribe,
} from '../../src/notify/push'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop'
const BORIS = 4242

/** initData as Telegram signs it, for this user at this time. */
function signed(userId: number, authDate: number, token = TOKEN): string {
  const fields: [string, string][] = [
    ['auth_date', String(authDate)],
    ['query_id', 'AAH-test'],
    ['user', JSON.stringify({ id: userId, first_name: 'Борис' })],
  ]
  const p = new URLSearchParams(fields)
  p.set('hash', initDataHash(fields, token))
  return p.toString()
}
const nowS = () => Math.floor(Date.now() / 1000)

describe('the signature of the Mini App (T11)', () => {
  it('FR-UI-4: a fresh initData of the bot is good; a changed field, another bot, a stale day are not', () => {
    expect(checkInitData(signed(BORIS, nowS()), TOKEN)).toMatchObject({ ok: true, userId: BORIS })
    const tampered = signed(BORIS, nowS()).replace(
      encodeURIComponent('"id":4242'),
      encodeURIComponent('"id":4243'),
    )
    expect(checkInitData(tampered, TOKEN)).toEqual({ ok: false, why: 'signature' })
    expect(checkInitData(signed(BORIS, nowS(), '999:other-bot'), TOKEN)).toEqual({
      ok: false,
      why: 'signature',
    })
    expect(checkInitData(signed(BORIS, nowS() - 25 * 3600), TOKEN)).toEqual({
      ok: false,
      why: 'expired',
    })
    expect(checkInitData('user=1', TOKEN)).toEqual({ ok: false, why: 'malformed' })
  })
})

describe('the core lets the Mini App in', () => {
  let t: TestApp
  beforeEach(async () => {
    await resetDb(db)
    t = await buildTestApp(db)
    await t.secrets.set('telegram_bot_token', TOKEN)
    await db.insert(ownerAuth).values({ id: 1, telegramChatId: 111, telegramUserId: BORIS })
  })
  afterEach(() => t.close())

  const as = (initData: string, ip = '10.0.0.1') =>
    t.app.inject({
      method: 'GET',
      url: '/api/inbox',
      headers: { authorization: `tma ${initData}` },
      remoteAddress: ip,
    })

  it('ST-M7-02: Boris’s signed initData opens the pult without a password; another user does not', async () => {
    expect((await as(signed(BORIS, nowS()))).statusCode).toBe(200)
    const other = await as(signed(777, nowS()), '10.0.0.2')
    expect(other.statusCode).toBe(401)
    expect(other.json()).toEqual({ error: 'Открой приложение заново из Telegram.' })
    expect((await as(signed(BORIS, nowS() - 2 * 86_400), '10.0.0.3')).statusCode).toBe(401)
  })

  it('ST-M7-02: six bad signatures from one address are 429, another address still gets in', async () => {
    const bad = signed(BORIS, nowS(), '999:other-bot')
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await as(bad, '10.0.0.9')).statusCode)
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(codes[5]).toBe(429)
    expect((await as(signed(BORIS, nowS()), '10.0.0.10')).statusCode).toBe(200)
  })
})

describe('Web Push (pult v2 design 6)', () => {
  beforeEach(() => resetDb(db))
  const secrets = (() => {
    const store = new Map<string, string>()
    return {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      ensure: async (k: string, gen: () => string) => {
        if (!store.has(k)) store.set(k, gen())
        return store.get(k) as string
      },
    }
  })()

  it('FR-NOTIF-1: the VAPID token is ES256 over the push service’s origin, checked by the public key', async () => {
    const v = await _vapidForTests(secrets as never)
    const token = _vapidTokenForTests(
      v,
      'https://push.example.test/send/abc',
      'https://sara.example.test',
    )
    const [h, c, s] = token.split('.')
    expect(JSON.parse(Buffer.from(c ?? '', 'base64url').toString())).toMatchObject({
      aud: 'https://push.example.test',
      sub: 'https://sara.example.test',
    })
    const key = createPublicKey({ key: { ...v.jwk, d: undefined }, format: 'jwk' })
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s ?? '', 'base64url'),
      ),
    ).toBe(true)
    expect(Buffer.from(v.publicKey, 'base64url')).toHaveLength(65)
  })

  it('FR-NOTIF-1: a kind that is on rings every device with no data; a gone device is dropped; a kind that is off rings none', async () => {
    await subscribe(db, {
      endpoint: 'https://push.example.test/a',
      p256dh: 'p',
      auth: 'a',
      label: 'телефон',
    })
    await subscribe(db, {
      endpoint: 'https://push.example.test/b',
      p256dh: 'p',
      auth: 'a',
      label: 'ноутбук',
    })
    const calls: { url: string; init: RequestInit }[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status: url.endsWith('/b') ? 410 : 201 })
    }) as unknown as typeof globalThis.fetch
    const d = { db, secrets: secrets as never, publicUrl: 'https://sara.example.test', fetch }
    expect(await pushNotice(d, 'urgent')).toBe(1)
    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://push.example.test/a',
      'https://push.example.test/b',
    ])
    expect(calls[0]?.init.headers).toMatchObject({ Urgency: 'high', 'Content-Length': '0' })
    expect(calls[0]?.init.body).toBeUndefined()
    expect((await db.select().from(pushSubscription)).map((s) => s.endpoint)).toEqual([
      'https://push.example.test/a',
    ])
    calls.length = 0
    // Summaries ring nowhere by default.
    expect(await pushNotice(d, 'summary')).toBe(0)
    expect(calls).toEqual([])
  })

  it('FR-NOTIF-2: the woken worker shows the latest notice, silent in the quiet hours unless urgent', async () => {
    await db
      .insert(setting)
      .values({ key: 'cards.quiet_hours', value: { from: 0, to: 0 }, changedBy: 'boris' })
    await db.insert(notice).values({
      id: newEventId(),
      kind: 'lead',
      title: 'Заявка: Сайт',
      body: 'Краснодар',
      link: '/leads/1',
    })
    expect(await latestForPush(db)).toMatchObject({
      title: 'Заявка: Сайт',
      link: '/leads/1',
      silent: true,
    })
    await db
      .insert(notice)
      .values({ id: newEventId(), kind: 'urgent', title: 'Клиент просит позвонить', body: '' })
    expect((await latestForPush(db))?.silent).toBe(false)
  })

  it('FR-NOTIF-3: a new notice rings once; the same card within the hour does not ring again', async () => {
    const rang: NoticeKind[] = []
    let id = 500
    const base: Notifier = {
      sendLeadCard: async () => ({ messageId: id++ }),
      closeLeadCard: async () => {},
      sendText: async () => ({ messageId: id++ }),
      sendButtons: async () => ({ messageId: id++ }),
    }
    const n = withNoticeLog(base, db, (k) => rang.push(k))
    const task = newEventId()
    const rows = [[{ text: 'Отправить', callbackData: `t:${task}:send` }]]
    await n.sendText('🚨 Клиент просит позвонить')
    await n.sendButtons('💬 Анна\nМожете позвонить?', rows)
    await n.sendButtons('💬 Анна\nМожете позвонить?', rows)
    expect(rang).toEqual(['urgent', 'client'])
  })
})
