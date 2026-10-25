import { describe, expect, it } from 'vitest'
import {
  ENTITY_KINDS,
  EntityRefSchema,
  entityPath,
  SECTIONS,
  TASK_ACTIONS,
  TASK_KINDS,
} from '../src'

describe('entity homes', () => {
  it('FR-UI-2: every entity kind has a home path', () => {
    for (const kind of ENTITY_KINDS) {
      const id = kind === 'message' ? 'c 1:m 2' : 'x 1'
      const path = entityPath(kind, id)
      expect(path.startsWith('/'), kind).toBe(true)
      expect(path.includes(' '), kind).toBe(false)
    }
  })

  it('FR-UI-2: an id with a slash stays one path segment', () => {
    expect(entityPath('lead', 'a/b')).toBe('/leads/a%2Fb')
    expect(entityPath('client', '7')).toBe('/clients/7')
    expect(entityPath('message', 'c9:m3')).toBe('/clients/c9#m-m3')
    expect(entityPath('setting', 'money.daily_bids')).toBe('/settings#money.daily_bids')
    expect(entityPath('cutover', 'bids')).toBe('/settings/switch#bids')
  })

  it('FR-UI-2: an entity chip is checked by its schema', () => {
    expect(EntityRefSchema.parse({ kind: 'lead', id: '1', title: 'Сайт', sub: null }).kind).toBe(
      'lead',
    )
    expect(() => EntityRefSchema.parse({ kind: 'nope', id: '1', title: 'x', sub: null })).toThrow()
  })
})

describe('sections', () => {
  it('FR-UI-1: the menu has the fourteen sections of the spec', () => {
    expect(SECTIONS.map((s) => s.title)).toEqual([
      'Сегодня',
      'Входящие',
      'Заявки',
      'Клиенты',
      'Встречи',
      'Разум',
      'Тренажёр',
      'Экзамены',
      'Аналитика',
      'Аккаунты',
      'Настройки',
      'Состояние',
      'Журнал',
      'Справка',
    ])
    expect(SECTIONS.filter((s) => s.inTabs).map((s) => s.title)).toEqual([
      'Сегодня',
      'Заявки',
      'Клиенты',
      'Настройки',
    ])
    expect(new Set(SECTIONS.map((s) => s.path)).size).toBe(SECTIONS.length)
  })
})

describe('task kinds', () => {
  it('FR-UI-6: every task kind the core creates has its actions', () => {
    for (const kind of ['lead_decision', 'lead_review', 'lead_held', 'rule_proposal']) {
      const k = TASK_KINDS[kind]
      expect(k, kind).toBeDefined()
      expect(k?.actions.length, kind).toBeGreaterThan(0)
      for (const a of k?.actions ?? [])
        expect(TASK_ACTIONS as readonly string[], `${kind}:${a.action}`).toContain(a.action)
    }
  })
})
