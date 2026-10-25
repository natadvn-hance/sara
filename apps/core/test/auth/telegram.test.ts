import { describe, expect, it } from 'vitest'
import { verifyInitData } from '../../src/auth/telegram'
import { OWNER_TG_ID, ownerInitData, signInitData, TEST_BOT_TOKEN } from '../helpers/initData'

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0)
const opts = { botToken: TEST_BOT_TOKEN, ownerUserId: OWNER_TG_ID, nowMs: NOW }

describe('Mini App launch data', () => {
  it('FR-UI-4: T11 a signed initData of the owner passes', () => {
    expect(verifyInitData(ownerInitData({ nowMs: NOW }), opts)).toEqual({
      ok: true,
      userId: OWNER_TG_ID,
    })
  })

  it('FR-UI-4: T11 a changed field fails with signature', () => {
    const forged = ownerInitData({ nowMs: NOW }).replace('%D0%91%D0%BE%D1%80%D0%B8%D1%81', 'Eve')
    expect(forged).not.toBe(ownerInitData({ nowMs: NOW }))
    expect(verifyInitData(forged, opts)).toEqual({ ok: false, reason: 'signature' })
  })

  it('FR-UI-4: T11 an initData older than a day fails with expired', () => {
    expect(verifyInitData(ownerInitData({ nowMs: NOW, ageS: 86_401 }), opts)).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(verifyInitData(ownerInitData({ nowMs: NOW, ageS: 86_000 }), opts).ok).toBe(true)
  })

  it('FR-UI-4: T11 another Telegram user fails with user', () => {
    expect(verifyInitData(ownerInitData({ nowMs: NOW, userId: 999 }), opts)).toEqual({
      ok: false,
      reason: 'user',
    })
  })

  it('FR-UI-4: T11 an initData signed by an old bot token fails', () => {
    const old = ownerInitData({ nowMs: NOW, botToken: '1:OldTokenOldTokenOldTokenOldToken' })
    expect(verifyInitData(old, opts)).toEqual({ ok: false, reason: 'signature' })
  })

  it('FR-UI-4: T11 without a bound owner nobody gets in', () => {
    expect(verifyInitData(ownerInitData({ nowMs: NOW }), { ...opts, ownerUserId: null })).toEqual({
      ok: false,
      reason: 'no_owner',
    })
  })

  it('FR-UI-4: T11 garbage, a missing hash or a missing user is refused', () => {
    expect(verifyInitData('', opts)).toEqual({ ok: false, reason: 'format' })
    expect(verifyInitData('auth_date=1&user=%7B%7D', opts)).toEqual({ ok: false, reason: 'format' })
    const noUser = signInitData({ auth_date: String(Math.floor(NOW / 1000)) })
    expect(verifyInitData(noUser, opts)).toEqual({ ok: false, reason: 'user' })
  })
})
