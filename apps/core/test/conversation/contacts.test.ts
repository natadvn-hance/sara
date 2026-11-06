import { describe, expect, it } from 'vitest'
import { contactsFromChat, contactsLine, firstNameIn } from '../../src/conversation/contacts'

describe('contacts out of a chat (by code)', () => {
  it('FR-CONV-13: the person and the number of the real scene: a name in a case, a phone with 8', () => {
    const c = contactsFromChat([
      'могу попросить вас набрать Екатерине Геннадьевне завтра по номеру 8900 123-45-67 в 15:30?',
    ])
    expect(c.names).toEqual(['Екатерина Геннадьевна'])
    expect(c.phones).toEqual(['+7 900 123-45-67'])
  })

  it('FR-CONV-13: a first name alone after «набрать» is found and put in the nominative', () => {
    expect(contactsFromChat(['наберите Екатерине в пятницу']).names).toEqual(['Екатерина'])
    expect(firstNameIn('Екатерине')).toBe('Екатерина')
  })

  it('FR-CONV-13: our own number and Telegram are never shown as the client’s', () => {
    const c = contactsFromChat([
      'мой номер +7 900 278-18-27, телеграм @bmnoian',
      'а мой 89161234567 и @client_anna',
    ])
    expect(c.phones).toEqual(['+7 916 123-45-67'])
    expect(c.telegrams).toEqual(['@client_anna'])
  })

  it('FR-CONV-13: a mail address is no Telegram, a t.me link is one', () => {
    const c = contactsFromChat(['пишите на anna.k@mail.ru или t.me/anna_k'])
    expect(c.emails).toEqual(['anna.k@mail.ru'])
    expect(c.telegrams).toEqual(['@anna_k'])
  })

  it('FR-CONV-13: the name already on the order and our own names are left out', () => {
    const c = contactsFromChat(['это Анна, а Борис вам позвонит'], ['Анна'])
    expect(c.names).toEqual([])
  })

  it('FR-CONV-13: the line is joined by dots and is empty with nothing found', () => {
    expect(contactsLine(contactsFromChat(['привет']))).toBeNull()
    expect(contactsLine(contactsFromChat(['звоните 89161234567, @anna_k']))).toBe(
      '+7 916 123-45-67 · @anna_k',
    )
  })
})
