import { describe, expect, it } from 'vitest'
import {
  GREETING_FORMS,
  greetedName,
  greetingFor,
  greetingShape,
  pickGreetingForm,
} from '../../src/text/clientText'

// Boris, 11.11.2026: «Все время разный как у человека». Invented names only.
const MORNING = new Date('2026-10-26T06:00:00Z')
const NOON = new Date('2026-10-26T09:00:00Z')
const EVENING = new Date('2026-10-26T16:00:00Z')

describe('a greeting of ours in more than one form (Boris, 11.11.2026)', () => {
  it('FR-CONV-4: four forms with a name, the part of the day where it has one, «Добрый день!» or «Здравствуйте!» without', () => {
    expect(GREETING_FORMS.map((f) => greetingFor(NOON, 'Алексей', f))).toEqual([
      'Алексей, добрый день!',
      'Добрый день, Алексей!',
      'Здравствуйте, Алексей!',
      'Алексей, здравствуйте!',
    ])
    expect(greetingFor(MORNING, 'Алексей', 'name_after')).toBe('Доброе утро, Алексей!')
    expect(greetingFor(EVENING, 'Алексей', 'name_after')).toBe('Добрый вечер, Алексей!')
    expect(greetingFor(EVENING, 'Алексей', 'hello_after')).toBe('Здравствуйте, Алексей!')
    expect(GREETING_FORMS.map((f) => greetingFor(NOON, null, f))).toEqual([
      'Добрый день!',
      'Добрый день!',
      'Здравствуйте!',
      'Здравствуйте!',
    ])
    // A word that is no name is never put in, whatever the form.
    expect(greetingFor(NOON, 'Психотерапевт', 'name_after')).toBe('Добрый день!')
    // Without a form it is the one it always was.
    expect(greetingFor(NOON, 'Алексей')).toBe('Алексей, добрый день!')
  })

  it('FR-CONV-4: the shape of a greeting is its word and where the name stands, whatever the hour', () => {
    expect(greetingShape('Алексей, доброе утро!')).toBe(greetingShape('Алексей, добрый вечер!'))
    expect(greetingShape('Добрый день, Алексей!\n\nПосмотрел задачу')).toBe('day:after')
    expect(greetingShape('Здравствуйте, Алексей! Посмотрел задачу')).toBe('hello:after')
    expect(greetingShape('[имя 1], здравствуйте!')).toBe('hello:before')
    expect(greetingShape('Добрый день!')).toBe('day:none')
    expect(greetingShape('Доброго дня, Алексей!')).toBe('gen:after')
    expect(greetingShape('Понимаю, добрый день у вас был')).toBeNull()
    expect(greetingShape('Посмотрел задачу')).toBeNull()
  })

  it('FR-CONV-4: the name a message of ours greeted the client with, before or after the greeting', () => {
    expect(greetedName('Алексей, добрый день!\n\nПосмотрел')).toBe('Алексей')
    expect(greetedName('Добрый день, Алексей!')).toBe('Алексей')
    expect(greetedName('Здравствуйте, Анна-Мария! Посмотрел')).toBe('Анна-Мария')
    expect(greetedName('Доброго вечера, Алексей!')).toBe('Алексей')
    expect(greetedName('Добрый день!')).toBeNull()
    expect(greetedName('Понимаю, добрый день у вас был')).toBeNull()
    expect(greetedName('[имя 1], добрый день!')).toBeNull()
  })

  it('FR-CONV-4: the form never repeats the shape of the last greeting, and stays the same on a repeat of the step', () => {
    for (let n = 0; n < 30; n++) {
      const seed = `95812${n}`
      const last = greetingFor(NOON, 'Алексей', GREETING_FORMS[n % 4])
      const form = pickGreetingForm(seed, 'Алексей', [last])
      expect(greetingShape(greetingFor(NOON, 'Алексей', form))).not.toBe(greetingShape(last))
      expect(pickGreetingForm(seed, 'Алексей', [last])).toBe(form)
    }
    // Two before it are both avoided while a form is left.
    const two = ['Добрый день, Алексей!', 'Алексей, здравствуйте!']
    for (let n = 0; n < 20; n++) {
      const text = greetingFor(NOON, 'Алексей', pickGreetingForm(`c-${n}`, 'Алексей', two))
      expect(two).not.toContain(text)
    }
  })

  it('FR-CONV-4: different orders get different forms, not one for all', () => {
    const forms = new Set(
      Array.from({ length: 20 }, (_, n) =>
        pickGreetingForm(`9581${n}`, 'Алексей', ['Алексей, добрый день!']),
      ),
    )
    expect(forms.size).toBeGreaterThanOrEqual(3)
  })

  it('FR-CONV-4: without a name the other of «Добрый день!» and «Здравствуйте!» comes next', () => {
    for (let n = 0; n < 10; n++) {
      expect(greetingFor(NOON, null, pickGreetingForm(`s${n}`, null, ['Добрый день!']))).toBe(
        'Здравствуйте!',
      )
      expect(
        greetingFor(NOON, null, pickGreetingForm(`s${n}`, null, ['Здравствуйте! Как дела?'])),
      ).toBe('Добрый день!')
    }
  })

  it('FR-CONV-4: with nothing before it the greeting is the one Sara always opened with', () => {
    expect(pickGreetingForm('95812257', 'Алексей', [])).toBe('name_first')
    expect(pickGreetingForm('95812257', 'Алексей', ['Посмотрел задачу'])).toBe('name_first')
  })
})
