import { describe, expect, it } from 'vitest'
import {
  BID_TEXT_MAX,
  bidLengthMax,
  bidTextAt,
  bidTextDetail,
  draftOf,
  editOf,
  greetingOf,
  greetingRoom,
  longestGreeting,
  removeEmoji,
} from '../src/leads/draft'

// Moscow is UTC+3 all year. These are the moments the rules are tested at.
const at = (iso: string) => new Date(iso)
const M_1159 = at('2026-10-26T08:59:00Z')
const M_1200 = at('2026-10-26T09:00:00Z')
const M_1759 = at('2026-10-26T14:59:00Z')
const M_1800 = at('2026-10-26T15:00:00Z')
const MIDNIGHT = at('2026-10-26T21:00:00Z')
// Written by code: CI forbids the long dash in a file.
const LONG = String.fromCharCode(0x2014)
const MEDIUM = String.fromCharCode(0x2013)
const ANY_DASH = new RegExp(`[${MEDIUM}${LONG}]`)

describe('greetingOf: by Moscow time (FR-LEAD-6, rule 5)', () => {
  it('FR-LEAD-6: the greeting is the one of the given moment, with the name when it is known', () => {
    expect(greetingOf('Ирина', M_1159)).toBe('Ирина, доброе утро!')
    expect(greetingOf('Ирина', M_1200)).toBe('Ирина, добрый день!')
    expect(greetingOf('Ирина', M_1759)).toBe('Ирина, добрый день!')
    expect(greetingOf('Ирина', M_1800)).toBe('Ирина, добрый вечер!')
    expect(greetingOf('', MIDNIGHT)).toBe('Доброе утро!')
    expect(greetingOf('Клиент 3', M_1800)).toBe('Добрый вечер!')
    expect(greetingOf('  Анна Петрова ', M_1200)).toBe('Анна, добрый день!')
  })

  it('FR-LEAD-6: without a moment it is the greeting of now', () => {
    expect(['Доброе утро!', 'Добрый день!', 'Добрый вечер!']).toContain(greetingOf(''))
  })

  it('FR-LEAD-6: the longest greeting is the evening one, whatever the name', () => {
    expect(longestGreeting('Ирина')).toBe('Ирина, добрый вечер!')
    expect(longestGreeting('')).toBe('Добрый вечер!')
    for (const name of ['', 'Ирина', 'Анна-Мария'])
      for (const now of [M_1159, M_1200, M_1759, M_1800, MIDNIGHT])
        expect(longestGreeting(name).length).toBeGreaterThanOrEqual(greetingOf(name, now).length)
  })

  it('FR-LEAD-6: the room of a stored greeting is the length it has in the evening', () => {
    expect(greetingRoom('Ирина, доброе утро!')).toBe('Ирина, добрый вечер!'.length)
    expect(greetingRoom('Ирина, добрый день!')).toBe('Ирина, добрый вечер!'.length)
    expect(greetingRoom('Ирина, добрый вечер!')).toBe('Ирина, добрый вечер!'.length)
    expect(greetingRoom('Добрый день!')).toBe('Добрый вечер!'.length)
  })
})

describe('removeEmoji (FR-LEAD-6, rule 8)', () => {
  it('FR-LEAD-6: emoji of every kind go, the text around them stays', () => {
    for (const e of ['🤝', '🙏', '😊', '👍🏽', '❤️', '👨‍👩‍👧', '🇷🇺', '✅', '☎️'])
      expect(removeEmoji(`Спасибо ${e} за ответ`).replace(/ +/g, ' ')).toBe('Спасибо за ответ')
    expect(removeEmoji('Договорились🤝')).toBe('Договорились')
  })

  it('FR-LEAD-6: letters, digits, signs and the marks of a brand are not emoji', () => {
    const text = 'Сайт за 30 000 ₽, 2-3 недели, 10% скидка, Hance™ и © 2026, → дальше, №5, 1) раз'
    expect(removeEmoji(text)).toBe(text)
  })
})

describe('bidTextAt: the text of a bid at the moment it is sent (FR-LEAD-6, rule 5)', () => {
  const stored = 'Ирина, добрый день!\n\nПонимаю задачу\n\nКогда запуск?'

  it('FR-LEAD-6: a bid pressed at 11:59 Moscow time greets «доброе утро», at 12:00 «добрый день»', () => {
    expect(bidTextAt(stored, 'Ирина', M_1159)).toBe(
      'Ирина, доброе утро!\n\nПонимаю задачу\n\nКогда запуск?',
    )
    expect(bidTextAt(stored, 'Ирина', M_1200)).toBe(
      'Ирина, добрый день!\n\nПонимаю задачу\n\nКогда запуск?',
    )
  })

  it('FR-LEAD-6: a draft made in the morning and sent in the evening greets «добрый вечер»', () => {
    const morning = draftOf('Понимаю задачу.\n\nКогда запуск?', 'Ирина', M_1159)
    expect(morning).toBe('Ирина, доброе утро!\n\nПонимаю задачу\n\nКогда запуск?')
    expect(bidTextAt(morning, 'Ирина', M_1800)).toBe(
      'Ирина, добрый вечер!\n\nПонимаю задачу\n\nКогда запуск?',
    )
    expect(bidTextAt(morning, 'Ирина', M_1759)).toBe(
      'Ирина, добрый день!\n\nПонимаю задачу\n\nКогда запуск?',
    )
  })

  it('FR-LEAD-6: a greeting without a name stays without one', () => {
    expect(bidTextAt('Добрый день!\n\nТекст', 'Ирина', M_1800)).toBe('Добрый вечер!\n\nТекст')
    expect(bidTextAt('Добрый день!\n\nТекст', '', M_1159)).toBe('Доброе утро!\n\nТекст')
  })

  it('FR-LEAD-6: the name Boris wrote in his greeting is kept, not the one of the board', () => {
    expect(bidTextAt('Юля, добрый день!\n\nТекст', 'Анна Петрова', M_1800)).toBe(
      'Юля, добрый вечер!\n\nТекст',
    )
    expect(bidTextAt('Доброго дня, Юля!\n\nТекст', 'Анна', M_1159)).toBe(
      'Юля, доброе утро!\n\nТекст',
    )
  })

  it("FR-LEAD-6: Boris's own «Здравствуйте» or «Добрый день, Имя» as the whole first sentence is the greeting of the moment too", () => {
    expect(bidTextAt('Здравствуйте, Ирина! Текст', 'Ирина', M_1800)).toBe(
      'Ирина, добрый вечер!\n\nТекст',
    )
    expect(bidTextAt('Привет!\n\nТекст', '', M_1159)).toBe('Доброе утро!\n\nТекст')
    expect(bidTextAt('Добрый день, Ирина!\n\nТекст', 'Ирина', M_1159)).toBe(
      'Ирина, доброе утро!\n\nТекст',
    )
  })

  it("FR-LEAD-6: a first sentence that greets and says more is Boris's own and stays whole", () => {
    expect(bidTextAt('Здравствуйте, Ирина, вижу задачу. Когда старт?', 'Ирина', M_1800)).toBe(
      'Здравствуйте, Ирина, вижу задачу. Когда старт?',
    )
  })

  it('FR-LEAD-6: a word that only begins like a greeting is not one', () => {
    expect(bidTextAt('Приветливый персонал решает всё.\n\nКогда запуск?', 'Ирина', M_1800)).toBe(
      'Ирина, добрый вечер!\n\nПриветливый персонал решает всё\n\nКогда запуск?',
    )
  })

  it('FR-LEAD-6: a stored text with no greeting gets the one of the moment and the name of the board', () => {
    expect(bidTextAt('Понимаю задачу', 'Ирина', M_1159)).toBe(
      'Ирина, доброе утро!\n\nПонимаю задачу',
    )
  })

  it('NFR-UX-1: dashes, hyphens in common words, final periods and emoji are gone, names and ranges stay', () => {
    const text = [
      'Ирина, добрый день!',
      `Сайт ${LONG} это просто, что-то ${MEDIUM} все-таки сделаем 🤝.`,
      'Срок 2-3 недели, Санкт-Петербург, Wi-Fi и SEO-продвижение, Telegram-бот 🙏.',
      'Когда запуск? 😊',
    ].join('\n\n')
    expect(bidTextAt(text, 'Ирина', M_1200)).toBe(
      [
        'Ирина, добрый день!',
        'Сайт это просто, что то все таки сделаем',
        'Срок 2-3 недели, Санкт-Петербург, Wi-Fi и SEO продвижение, Telegram бот',
        'Когда запуск?',
      ].join('\n\n'),
    )
  })

  it('FR-LEAD-6: the paragraphs are separated by one empty line', () => {
    expect(bidTextAt('Ирина, добрый день!\nТекст\n\n\n\nЕщё', 'Ирина', M_1200)).toBe(
      'Ирина, добрый день!\n\nТекст\n\nЕщё',
    )
  })

  it('FR-LEAD-6: a case link stays as it is, its hyphens too', () => {
    const text =
      'Ирина, добрый день!\n\nТекст\n\nПохожая работа: Сайт клиники, https://hance.example/cases/clinic-spb'
    expect(bidTextAt(text, 'Ирина', M_1800)).toBe(
      'Ирина, добрый вечер!\n\nТекст\n\nПохожая работа: Сайт клиники, https://hance.example/cases/clinic-spb',
    )
  })

  it('FR-LEAD-6: building it twice gives the same text', () => {
    const once = bidTextAt(`Ирина, добрый день!\n\nСайт ${LONG} да. Что-то 🤝.`, 'Ирина', M_1800)
    expect(bidTextAt(once, 'Ирина', M_1800)).toBe(once)
    // And a later moment only changes the greeting.
    expect(bidTextAt(once, 'Ирина', M_1159)).toBe(once.replace('добрый вечер', 'доброе утро'))
  })

  it('FR-LEAD-6: whatever the hour, the text holds no long or medium dash and starts with a greeting of that hour', () => {
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(Date.UTC(2026, 9, 26, hour, 0, 0))
      const out = bidTextAt(`Ирина, добрый день!\n\nА ${LONG} б`, 'Ирина', now)
      expect(out.startsWith(greetingOf('Ирина', now)), out).toBe(true)
      expect(out).not.toMatch(ANY_DASH)
    }
  })
})

describe('the 500 characters of the bid form hold with the greeting at any hour (FR-LEAD-6)', () => {
  it('FR-LEAD-6: a draft that fits in the morning fits in the evening: the longest greeting is counted', () => {
    const room = BID_TEXT_MAX - longestGreeting('Ирина').length - 2
    const fits = draftOf('а'.repeat(room), 'Ирина', M_1159)
    expect(bidLengthMax(fits, 'Ирина')).toBe(BID_TEXT_MAX)
    expect(bidTextAt(fits, 'Ирина', M_1800).length).toBe(BID_TEXT_MAX)
    const over = draftOf('а'.repeat(room + 1), 'Ирина', M_1159)
    expect(over.length).toBe(BID_TEXT_MAX)
    expect(bidLengthMax(over, 'Ирина')).toBe(BID_TEXT_MAX + 1)
  })

  it('FR-LEAD-6: the length is the one of the text as it is sent, after the dashes, periods and emoji go', () => {
    const body = `${'а'.repeat(480)} ${LONG} 🤝.`
    expect(bidLengthMax(`Ирина, добрый день!\n\n${body}`, 'Ирина')).toBe(
      longestGreeting('Ирина').length + 2 + 480,
    )
  })

  it('FR-LEAD-6: an old draft of exactly 500 that the evening greeting would push over goes without the name, then as it was', () => {
    const body = 'а'.repeat(BID_TEXT_MAX - 'Ирина, добрый день!'.length - 2)
    const old = `Ирина, добрый день!\n\n${body}`
    expect(old.length).toBe(BID_TEXT_MAX)
    const evening = bidTextAt(old, 'Ирина', M_1800)
    expect(evening).toBe(`Добрый вечер!\n\n${body}`)
    expect(evening.length).toBeLessThanOrEqual(BID_TEXT_MAX)
    // With no name to drop the text keeps the greeting it had.
    const nameless = `Добрый день!\n\n${'б'.repeat(BID_TEXT_MAX - 'Добрый день!'.length - 2)}`
    expect(nameless.length).toBe(BID_TEXT_MAX)
    expect(bidTextAt(nameless, '', M_1800)).toBe(nameless)
  })
})

describe('bidTextDetail: what had to give way to the 500 characters (FR-LEAD-6)', () => {
  it('FR-LEAD-6: a normal draft has nothing to say', () => {
    expect(bidTextDetail('Ирина, добрый день!\n\nТекст', 'Ирина', M_1800)).toEqual({
      text: 'Ирина, добрый вечер!\n\nТекст',
      fallback: null,
    })
  })

  it('FR-LEAD-6: the name goes first, and it is said', () => {
    const body = 'а'.repeat(BID_TEXT_MAX - 'Ирина, добрый день!'.length - 2)
    expect(bidTextDetail(`Ирина, добрый день!\n\n${body}`, 'Ирина', M_1800)).toEqual({
      text: `Добрый вечер!\n\n${body}`,
      fallback: 'name_dropped',
    })
  })

  it('FR-LEAD-6: with no name to drop the greeting stays as it was, and it is said', () => {
    const body = 'б'.repeat(BID_TEXT_MAX - 'Добрый день!'.length - 2)
    expect(bidTextDetail(`Добрый день!\n\n${body}`, '', M_1800)).toEqual({
      text: `Добрый день!\n\n${body}`,
      fallback: 'greeting_kept',
    })
  })
})

describe('draftOf and editOf keep the voice rules (NFR-UX-1)', () => {
  it('NFR-UX-1: the draft of the model has no dash, no final period and no emoji', () => {
    expect(draftOf(`Сайт ${LONG} это просто. 🤝\n\nКогда запуск?`, '', M_1200)).toBe(
      'Добрый день!\n\nСайт это просто\n\nКогда запуск?',
    )
  })

  it("NFR-UX-1: Boris's own text gets the same, and his greeting stays in the stored text", () => {
    expect(editOf(`Сайт ${MEDIUM} это просто.`, '', M_1200)).toBe('Добрый день!\n\nСайт это просто')
    expect(editOf('Здравствуйте, Ирина! Текст.', 'Ирина', M_1200)).toBe(
      'Здравствуйте, Ирина! Текст',
    )
  })
})
