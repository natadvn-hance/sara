import { describe, expect, it } from 'vitest'
import { namesToHide } from '../src/leads/clientName'

describe('the names a model must not see', () => {
  it('NFR-PRIV-2: a given name is hidden as written', () => {
    expect(namesToHide('Ирина')).toEqual(['Ирина'])
    expect(namesToHide('  Анна   Петрова ')).toEqual(['Анна Петрова'])
  })

  it('NFR-PRIV-2: what the site shows in place of a name is no name', () => {
    expect(namesToHide('Клиент 3', 'Заказчик', '', null, undefined)).toEqual([])
    expect(namesToHide('Иван (клиент)')).toEqual(['Иван'])
  })

  it('NFR-PRIV-2: the board name and the order page name are both hidden, once each', () => {
    expect(namesToHide('Анна(Юля)', 'Анна Петрова', 'Анна(Юля)')).toEqual([
      'Анна Юля',
      'Анна Петрова',
    ])
  })
})
