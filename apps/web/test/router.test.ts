import { ENTITY_KINDS, entityPath, SECTIONS } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { matchRoute, tabOf } from '../src/app/router'
import { launchData } from '../src/app/telegram'

describe('router', () => {
  it('FR-UI-2: the router opens every section and every entity home', () => {
    for (const s of SECTIONS) expect(matchRoute(s.path), s.path).not.toBeNull()
    expect(matchRoute('/settings/switch')?.screen).toBe('switch')
    for (const kind of ENTITY_KINDS) {
      const path = entityPath(kind, kind === 'message' ? 'c1:m1' : 'x1').split(/[#?]/)[0] ?? ''
      expect(matchRoute(path), `${kind} ${path}`).not.toBeNull()
    }
  })

  it('FR-UI-2: a home path gives its id, decoded', () => {
    expect(matchRoute('/leads/a%2Fb')).toEqual({ screen: 'lead', params: { id: 'a/b' } })
    expect(matchRoute('/accounts/hance-marketing/direction')).toEqual({
      screen: 'direction',
      params: { id: 'hance-marketing' },
    })
    expect(matchRoute('/nowhere/at/all')).toBeNull()
  })

  it('FR-UI-4: nested screens belong to their tab, the rest to the settings tab', () => {
    expect(tabOf('today')).toBe('today')
    expect(tabOf('lead')).toBe('leads')
    expect(tabOf('client')).toBe('clients')
    expect(tabOf('journal')).toBe('settings')
  })
})

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

describe('Telegram launch data', () => {
  const initData = 'query_id=AA&user=%7B%22id%22%3A1%7D&auth_date=1&hash=ab'

  it('FR-UI-4: launch data is read from the hash and kept for a reload', () => {
    const store = memory()
    const hash = `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0`
    expect(launchData(hash, store)).toBe(initData)
    expect(launchData('', store)).toBe(initData)
  })

  it('FR-UI-2: Telegram launch data in the hash does not change the route', () => {
    expect(matchRoute('/leads/9')?.params.id).toBe('9')
    expect(launchData(`#tgWebAppData=${encodeURIComponent(initData)}`, null)).toBe(initData)
  })

  it('FR-UI-4: a plain browser has no launch data', () => {
    expect(launchData('', memory())).toBeNull()
    expect(launchData('#m-12', null)).toBeNull()
  })
})
