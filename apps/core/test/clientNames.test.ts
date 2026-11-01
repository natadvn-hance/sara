import { describe, expect, it } from 'vitest'
import { addressName, namesToHide } from '../src/leads/clientName'

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

  it('NFR-PRIV-2: a hyphenated name is hidden whole and by its parts', () => {
    expect(namesToHide('Анна-Мария')).toEqual(['Анна-Мария', 'Анна', 'Мария'])
  })

  it('NFR-PRIV-2: a company form written in capitals is not a name', () => {
    expect(namesToHide('Ольга ИП Иванова')).toEqual(['Ольга Иванова'])
    expect(namesToHide('ООО Ромашка')).toEqual(['Ромашка'])
  })

  it('NFR-PRIV-2: «скрыт», «скрыл», «скрыто» all say the name is hidden', () => {
    expect(namesToHide('Пользователь скрыл имя', 'Имя скрыто', 'Скрытый клиент')).toEqual([])
  })
})

describe('FR-CONV-14: the name in a reply is the formal first name', () => {
  it('«alexander» becomes «Александр»; a profession is left out of the greeting; a good name stays', () => {
    expect(addressName('alexander, добрый день! Понял вас.', ['alexander'])).toBe(
      'Александр, добрый день! Понял вас.',
    )
    expect(addressName('Психотерапевт, добрый день! Картина понятна.', ['Психотерапевт'])).toBe(
      'Добрый день! Картина понятна.',
    )
    expect(addressName('Анна, здравствуйте!', ['Анна'])).toBe('Анна, здравствуйте!')
    expect(addressName('Добрый день!', [])).toBe('Добрый день!')
  })
})
