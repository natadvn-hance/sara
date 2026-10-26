import { CHECK_IDS, type Tone } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import {
  fixClientText,
  greetingFor,
  isBotQuestion,
  isGreetingForm,
  isShortReply,
  leadingGreeting,
  moscowPartOfDay,
  startsWithName,
  type VoiceIssueId,
  voiceIssues,
} from '../../src/text/clientText'

// Long and medium dashes are written by code, never typed (CI forbids the long one in files).
const LONG = String.fromCharCode(0x2014)
const MEDIUM = String.fromCharCode(0x2013)
const NBSP = String.fromCharCode(0xa0)

describe('fixClientText: the final period of a paragraph (FR-SPEECH-3, rule 4)', () => {
  it('FR-SPEECH-3: the period at the end of each paragraph goes, the rest of the text stays', () => {
    expect(fixClientText('Посмотрел задачу.\n\nЕсть ли тексты. Или нужен копирайтер.')).toBe(
      'Посмотрел задачу\n\nЕсть ли тексты. Или нужен копирайтер',
    )
  })

  it('FR-SPEECH-3: a paragraph that ends with a question, exclamation, ellipsis or bracket stays as it is', () => {
    const text = 'Какой у вас срок?\n\nОтлично!\n\nДумаю…\n\nКак вариант (см. выше)\n\nЖду...'
    expect(fixClientText(text)).toBe(text)
  })

  it('FR-SPEECH-3: a period after a bracket, a quote, a number or a domain goes too', () => {
    expect(fixClientText('Это недорого (от 30 тысяч).')).toBe('Это недорого (от 30 тысяч)')
    expect(fixClientText('Назовём это «Старт».')).toBe('Назовём это «Старт»')
    expect(fixClientText('Срок до 18.00.')).toBe('Срок до 18.00')
    expect(fixClientText('Смотрите на hance.ru.')).toBe('Смотрите на hance.ru')
  })

  it('FR-SPEECH-3: an abbreviation keeps its inner dots, only the final period of the paragraph goes', () => {
    expect(fixClientText('Нужны сайт, бот и т.д.')).toBe('Нужны сайт, бот и т.д')
    expect(fixClientText('Работаем с ООО и т.д. Пишите.')).toBe('Работаем с ООО и т.д. Пишите')
  })

  it('FR-SPEECH-3: a single line break is a line break, and a period at the end of a line goes as well', () => {
    expect(fixClientText('Адрес: Москва.\nСрок: неделя.')).toBe('Адрес: Москва\nСрок: неделя')
  })

  it('FR-SPEECH-3: the period before a closing emoji goes and the emoji is not touched', () => {
    expect(fixClientText('Договорились. 🤝')).toBe('Договорились 🤝')
    expect(fixClientText('Принял.🙏')).toBe('Принял 🙏')
    expect(fixClientText('Договорились 🤝.')).toBe('Договорились 🤝')
  })

  it('FR-SPEECH-3: two dots and an ellipsis of three dots are not a period', () => {
    expect(fixClientText('Хм..')).toBe('Хм..')
    expect(fixClientText('Хм...')).toBe('Хм...')
  })
})

describe('fixClientText: paragraphs and spaces (FR-SPEECH-3, rule 15)', () => {
  it('FR-SPEECH-3: paragraphs are separated by exactly one empty line', () => {
    expect(fixClientText('Раз\n\n\n\nДва\n \n\t\nТри')).toBe('Раз\n\nДва\n\nТри')
    expect(fixClientText('Раз\r\n\r\nДва')).toBe('Раз\n\nДва')
  })

  it('FR-SPEECH-3: spaces are trimmed and doubled spaces are one, a non-breaking space stays', () => {
    expect(fixClientText('  Привет   мир \n\n   Ещё  одно   ')).toBe('Привет мир\n\nЕщё одно')
    expect(fixClientText(`Цена 50${NBSP}000${NBSP}₽`)).toBe(`Цена 50${NBSP}000${NBSP}₽`)
  })

  it('FR-SPEECH-3: an empty text stays empty', () => {
    expect(fixClientText('')).toBe('')
    expect(fixClientText(' \n\n ')).toBe('')
  })
})

describe('fixClientText: dashes and hyphens (NFR-UX-1, rule 3)', () => {
  it('NFR-UX-1: a long and a medium dash between words are removed', () => {
    expect(fixClientText(`Сайт ${LONG} это визитка`)).toBe('Сайт это визитка')
    expect(fixClientText(`Сайт ${MEDIUM} это визитка`)).toBe('Сайт это визитка')
    expect(fixClientText(`Москва${LONG}столица`)).toBe('Москва столица')
  })

  it('NFR-UX-1: a spaced hyphen is a dash and is removed', () => {
    expect(fixClientText('Сайт - это визитка')).toBe('Сайт это визитка')
    expect(fixClientText('Wi-Fi - это быстро')).toBe('Wi-Fi это быстро')
  })

  it('NFR-UX-1: a dash at the start of a line, before a comma and at the end leaves no trace', () => {
    expect(fixClientText(`${LONG} Привет\n\n- Раз\n- Два`)).toBe('Привет\n\nРаз\nДва')
    expect(fixClientText(`Ждём ${LONG}, потом отвечу`)).toBe('Ждём, потом отвечу')
    expect(fixClientText(`Ждём вас ${LONG}`)).toBe('Ждём вас')
    expect(fixClientText(`Стоимость (${LONG} уточним) такая`)).toBe('Стоимость (уточним) такая')
  })

  it('NFR-UX-1: a dash between two numbers is a range and becomes a short hyphen', () => {
    expect(fixClientText(`Срок 2${MEDIUM}3 недели`)).toBe('Срок 2-3 недели')
    expect(fixClientText(`Скидка 10${LONG}15%`)).toBe('Скидка 10-15%')
    expect(fixClientText(`С 9:00 ${MEDIUM} 18:00`)).toBe('С 9:00-18:00')
    expect(fixClientText('От 30 - 60 тысяч')).toBe('От 30-60 тысяч')
    expect(fixClientText(`Телефон 123${MEDIUM}45${MEDIUM}67`)).toBe('Телефон 123-45-67')
    expect(fixClientText(`Скидка 10% ${LONG} 15%`)).toBe('Скидка 10%-15%')
  })

  it('NFR-UX-1: a number before a dash and a word after it is not a range', () => {
    expect(fixClientText(`Берём 5 ${LONG} это мало`)).toBe('Берём 5 это мало')
  })

  it('NFR-UX-1: a hyphen inside a common word becomes a space', () => {
    expect(fixClientText('Что-то пошло не так')).toBe('Что то пошло не так')
    expect(fixClientText('Это все-таки возможно')).toBe('Это все таки возможно')
    expect(fixClientText('Если кто-нибудь спросит')).toBe('Если кто нибудь спросит')
    expect(fixClientText('Напишу по-русски')).toBe('Напишу по русски')
    expect(fixClientText('Из-за срока и по-моему мнению')).toBe('Из за срока и по моему мнению')
    expect(fixClientText('Какой-то интернет-магазин')).toBe('Какой то интернет магазин')
  })

  it('NFR-UX-1: a common word with a capital at the start of a sentence is not taken for a name', () => {
    expect(fixClientText('Кто-то написал')).toBe('Кто то написал')
    expect(fixClientText('По-русски можно')).toBe('По русски можно')
    expect(fixClientText('Все-таки да')).toBe('Все таки да')
  })

  it('NFR-UX-1: a hyphen in a proper name keeps: two capitalized parts, or a capital with «на» inside', () => {
    expect(fixClientText('Мы из Санкт-Петербурга? Нет, из Санкт-Петербург')).toBe(
      'Мы из Санкт-Петербурга? Нет, из Санкт-Петербург',
    )
    expect(fixClientText('Клиент из Ростова-на-Дону')).toBe('Клиент из Ростова-на-Дону')
    expect(fixClientText('Офис в Ростов-на-Дону и Нью-Йорк')).toBe(
      'Офис в Ростов-на-Дону и Нью-Йорк',
    )
    expect(fixClientText('Анна-Мария, добрый день!')).toBe('Анна-Мария, добрый день!')
    expect(fixClientText('Комсомольск-на-Амуре и Орехово-Зуево')).toBe(
      'Комсомольск-на-Амуре и Орехово-Зуево',
    )
  })

  it('NFR-UX-1: a hyphen in a Latin brand keeps', () => {
    expect(fixClientText('Подключим Wi-Fi и A-Store')).toBe('Подключим Wi-Fi и A-Store')
    expect(fixClientText('Нужен e-mail и T-Bank')).toBe('Нужен e-mail и T-Bank')
    expect(fixClientText('Делаем Telegram-бот и SEO-продвижение')).toBe(
      'Делаем Telegram-бот и SEO-продвижение',
    )
  })

  it('NFR-UX-1: a name with a colon, a digit or a number keeps', () => {
    expect(fixClientText('Мы партнёры 1С:Франчайзи')).toBe('Мы партнёры 1С:Франчайзи')
    expect(fixClientText('Работаем с 1С-Битрикс и B2B-сегментом')).toBe(
      'Работаем с 1С-Битрикс и B2B-сегментом',
    )
    expect(fixClientText('Через 2-3 недели, скидка 10-15%, 5-летний опыт, 2-й этап')).toBe(
      'Через 2-3 недели, скидка 10-15%, 5-летний опыт, 2-й этап',
    )
  })

  it('NFR-UX-1: a phone number keeps its hyphens and its plus', () => {
    expect(fixClientText('Звоните: +7 (918) 123-45-67 или 8-800-555-35-35.')).toBe(
      'Звоните: +7 (918) 123-45-67 или 8-800-555-35-35',
    )
  })

  it('NFR-UX-1: a hyphen in a link or an address keeps', () => {
    expect(fixClientText('Смотрите https://hance-agency.ru/kejsy-sajty или sait-primer.рф.')).toBe(
      'Смотрите https://hance-agency.ru/kejsy-sajty или sait-primer.рф',
    )
    expect(fixClientText('Пишите на ivan-petrov@mail.ru')).toBe('Пишите на ivan-petrov@mail.ru')
  })

  it('NFR-UX-1: a typographic hyphen is a hyphen and follows the same rules', () => {
    expect(fixClientText('Что‑то и Санкт‑Петербург')).toBe('Что то и Санкт-Петербург')
  })

  it('NFR-UX-1: a text with no dashes and no hyphens comes out as it went in', () => {
    const text = 'Добрый день!\n\nПосмотрел задачу, сайт нужен к запуску?'
    expect(fixClientText(text)).toBe(text)
  })

  it('FR-SPEECH-3: fixing is idempotent', () => {
    const text = `Что-то ${LONG} сайт. Wi-Fi - да.\n\n\nСрок 2${MEDIUM}3 недели.`
    expect(fixClientText(fixClientText(text))).toBe(fixClientText(text))
  })

  it('NFR-UX-1: the fixed text holds no long or medium dash at all', () => {
    const out = fixClientText(`А ${LONG} б ${MEDIUM} в, г${LONG}д, 1${MEDIUM}2, ${LONG}е`)
    expect(out).not.toMatch(/[–—]/)
  })
})

describe('fixClientText: emoji (FR-SPEECH-3, rule 15)', () => {
  it('FR-SPEECH-3: emoji of every kind come out exactly as they went in', () => {
    const emoji = ['🤝', '🙏', '😊', '👍', '👍🏽', '❤️', '👨‍👩‍👧', '🇷🇺', '1️⃣', '☺️']
    for (const e of emoji) {
      expect(fixClientText(`Спасибо ${e} за ответ ${e}`)).toBe(`Спасибо ${e} за ответ ${e}`)
      expect(fixClientText(`Хорошо ${e}`)).toBe(`Хорошо ${e}`)
    }
  })

  it('FR-SPEECH-3: a text of only an emoji stays', () => {
    expect(fixClientText('🤝')).toBe('🤝')
  })
})

describe('greetingFor: by Moscow time (FR-SPEECH-3, rule 5)', () => {
  // Moscow is UTC+3 all year: 11:59 there is 08:59 UTC.
  const at = (iso: string) => new Date(iso)

  it('FR-SPEECH-3: before 12:00 in Moscow it is the morning, from 12:00 to 17:59 the day, from 18:00 the evening', () => {
    expect(greetingFor(at('2026-10-26T08:59:00Z'), null)).toBe('Доброе утро!')
    expect(greetingFor(at('2026-10-26T09:00:00Z'), null)).toBe('Добрый день!')
    expect(greetingFor(at('2026-10-26T14:59:00Z'), null)).toBe('Добрый день!')
    expect(greetingFor(at('2026-10-26T15:00:00Z'), null)).toBe('Добрый вечер!')
  })

  it('FR-SPEECH-3: the last millisecond before a boundary is still the earlier part of the day', () => {
    expect(greetingFor(at('2026-10-26T08:59:59.999Z'), null)).toBe('Доброе утро!')
    expect(greetingFor(at('2026-10-26T14:59:59.999Z'), null)).toBe('Добрый день!')
  })

  it('FR-SPEECH-3: midnight in Moscow is a new morning, though the UTC day is still the old one', () => {
    expect(greetingFor(at('2026-10-26T20:59:59Z'), null)).toBe('Добрый вечер!')
    expect(greetingFor(at('2026-10-26T21:00:00Z'), null)).toBe('Доброе утро!')
    expect(greetingFor(at('2026-10-26T02:00:00Z'), null)).toBe('Доброе утро!')
  })

  it('FR-SPEECH-3: the boundaries are the same in winter and in summer (Moscow has no summer time)', () => {
    for (const day of ['2026-01-15', '2026-07-15']) {
      expect(greetingFor(at(`${day}T08:59:00Z`), null)).toBe('Доброе утро!')
      expect(greetingFor(at(`${day}T09:00:00Z`), null)).toBe('Добрый день!')
      expect(greetingFor(at(`${day}T14:59:00Z`), null)).toBe('Добрый день!')
      expect(greetingFor(at(`${day}T15:00:00Z`), null)).toBe('Добрый вечер!')
    }
  })

  it('FR-SPEECH-3: with a name it stands first and the greeting follows in lower case', () => {
    expect(greetingFor(at('2026-10-26T08:00:00Z'), 'Анна')).toBe('Анна, доброе утро!')
    expect(greetingFor(at('2026-10-26T12:00:00Z'), 'Анна')).toBe('Анна, добрый день!')
    expect(greetingFor(at('2026-10-26T16:00:00Z'), 'Анна')).toBe('Анна, добрый вечер!')
  })

  it('FR-SPEECH-3: only the first name is used, a name in lower case is capitalized', () => {
    expect(greetingFor(at('2026-10-26T12:00:00Z'), 'Анна Петровна')).toBe('Анна, добрый день!')
    expect(greetingFor(at('2026-10-26T12:00:00Z'), 'анна')).toBe('Анна, добрый день!')
    expect(greetingFor(at('2026-10-26T12:00:00Z'), 'Анна-Мария')).toBe('Анна-Мария, добрый день!')
    expect(greetingFor(at('2026-10-26T12:00:00Z'), 'Анна(Юля)')).toBe('Анна, добрый день!')
  })

  it('FR-SPEECH-3: without a name, with an empty one or with the word Profi.ru shows instead, there is no name', () => {
    for (const none of [null, '', '  ', 'Клиент', 'Заказчик', 'Пользователь'])
      expect(greetingFor(at('2026-10-26T12:00:00Z'), none)).toBe('Добрый день!')
  })

  it('FR-SPEECH-3: the part of the day is named in one place', () => {
    expect(moscowPartOfDay(at('2026-10-26T08:59:00Z'))).toBe('morning')
    expect(moscowPartOfDay(at('2026-10-26T09:00:00Z'))).toBe('day')
    expect(moscowPartOfDay(at('2026-10-26T15:00:00Z'))).toBe('evening')
  })
})

describe('isGreetingForm and leadingGreeting (FR-SPEECH-3, rule 5)', () => {
  it('FR-SPEECH-3: the forms Boris allows are recognised', () => {
    for (const text of [
      'Добрый день!',
      'Доброе утро!',
      'Добрый вечер!',
      'Анна, добрый день!',
      'Анна, доброе утро!',
      'Анна, добрый вечер!',
      'Доброго дня, Анна!',
      'Доброго утра, Анна!',
      'Доброго вечера, Анна!',
      'Анна-Мария, добрый день!',
      'Доброго дня!',
      '[имя 1], добрый день!',
      '  Добрый день!  ',
      'Добрый день',
    ])
      expect(isGreetingForm(text), text).toBe(true)
  })

  it('FR-SPEECH-3: other openers and greetings with something after them are not a form', () => {
    for (const text of [
      '',
      'Здравствуйте!',
      'Анна, здравствуйте!',
      'Привет!',
      'Добрый день, Анна!',
      'Добрый день! Посмотрел задачу',
      'Добрый день, посмотрел задачу',
      'Анна, посмотрел задачу',
      'Понимаю, добрый день!',
      'Добрый день всем!',
      'Спокойной ночи!',
      'Анна, добрый день!\n\nПосмотрел',
    ])
      expect(isGreetingForm(text), text).toBe(false)
  })

  it('FR-SPEECH-3: with a moment given, the part of the day must be the right one', () => {
    const noon = new Date('2026-10-26T09:00:00Z')
    expect(isGreetingForm('Добрый день!', noon)).toBe(true)
    expect(isGreetingForm('Анна, добрый день!', noon)).toBe(true)
    expect(isGreetingForm('Доброго дня, Анна!', noon)).toBe(true)
    expect(isGreetingForm('Доброе утро!', noon)).toBe(false)
    expect(isGreetingForm('Добрый вечер!', noon)).toBe(false)
    expect(isGreetingForm('Доброго утра, Анна!', noon)).toBe(false)
    const before = new Date('2026-10-26T08:59:00Z')
    expect(isGreetingForm('Доброе утро!', before)).toBe(true)
    expect(isGreetingForm('Добрый день!', before)).toBe(false)
    const six = new Date('2026-10-26T15:00:00Z')
    expect(isGreetingForm('Добрый вечер!', six)).toBe(true)
    expect(isGreetingForm('Добрый день!', six)).toBe(false)
  })

  it('FR-SPEECH-3: whatever greetingFor builds, isGreetingForm recognises, at every hour', () => {
    for (let hour = 0; hour < 24; hour++)
      for (const name of [null, 'Анна', 'Анна-Мария']) {
        const now = new Date(Date.UTC(2026, 9, 26, hour, 0, 0))
        const greeting = greetingFor(now, name)
        expect(isGreetingForm(greeting, now), greeting).toBe(true)
      }
  })

  it('FR-SPEECH-3: leadingGreeting gives the greeting a text opens with and nothing otherwise', () => {
    expect(leadingGreeting('Анна, добрый день!\n\nПосмотрел задачу')).toBe('Анна, добрый день!')
    expect(leadingGreeting('Добрый день! Посмотрел задачу')).toBe('Добрый день!')
    expect(leadingGreeting('Доброго дня, Анна! Смотрю')).toBe('Доброго дня, Анна!')
    expect(leadingGreeting('Посмотрел задачу')).toBeNull()
    expect(leadingGreeting('Здравствуйте! Посмотрел задачу')).toBeNull()
    expect(leadingGreeting('Добрый день, посмотрел задачу')).toBeNull()
    expect(leadingGreeting('')).toBeNull()
  })
})

describe('startsWithName (FR-SPEECH-3, rule 6)', () => {
  it("FR-SPEECH-3: a text that opens with the client's name, then a comma, a mark or a space, does start with it", () => {
    expect(startsWithName('Анна, понял вас', 'Анна')).toBe(true)
    expect(startsWithName('Анна! Смотрю задачу', 'Анна')).toBe(true)
    expect(startsWithName('Анна, добрый день!', 'Анна')).toBe(true)
    expect(startsWithName('  Анна, понял', 'Анна')).toBe(true)
    expect(startsWithName('Анна', 'Анна')).toBe(true)
  })

  it('FR-SPEECH-3: letter case and ё do not matter, a full name from Profi.ru gives its first word', () => {
    expect(startsWithName('анна, понял', 'Анна')).toBe(true)
    expect(startsWithName('Артем, понял', 'Артём')).toBe(true)
    expect(startsWithName('Анна, понял', 'Анна Петровна')).toBe(true)
    expect(startsWithName('Анна-Мария, понял', 'Анна-Мария')).toBe(true)
  })

  it('FR-SPEECH-3: the tag the model is given for the name counts as the name', () => {
    expect(startsWithName('[имя 1], понял', 'Анна')).toBe(true)
  })

  it('FR-SPEECH-3: the name later in the text, another name, a longer name or no name is not a start with the name', () => {
    expect(startsWithName('Понял вас, Анна', 'Анна')).toBe(false)
    expect(startsWithName('Добрый день, Анна!', 'Анна')).toBe(false)
    expect(startsWithName('Ирина, понял', 'Анна')).toBe(false)
    expect(startsWithName('Аннализа, понял', 'Анна')).toBe(false)
    expect(startsWithName('Анна-Мария, понял', 'Анна')).toBe(false)
    expect(startsWithName('Анна, понял', null)).toBe(false)
    expect(startsWithName('Анна, понял', '')).toBe(false)
    expect(startsWithName('Клиент, понял', 'Клиент')).toBe(false)
    expect(startsWithName('', 'Анна')).toBe(false)
  })
})

describe('isShortReply (FR-SPEECH-3, rule 6)', () => {
  // A short reply is one the client reads as a nod, not as an answer: at most 5 words, at most 40 characters
  // (emoji not counted), at most 2 sentences, and no question.
  const w = (n: number) => 'а'.repeat(n)

  it("FR-SPEECH-3: the replies of Boris's examples are short", () => {
    for (const text of [
      'Принял',
      'Договорились 🤝',
      'Отлично, жду',
      'Спасибо!',
      'Хорошо 👍',
      'Да, удобно',
      'Понял, спасибо',
      'Принял. Жду',
      'Ок',
      '🤝',
    ])
      expect(isShortReply(text), text).toBe(true)
  })

  it('FR-SPEECH-3: a reply with a question, many words, many sentences or a lot of letters is substantive', () => {
    for (const text of [
      'Какой у вас бюджет?',
      'Принял?',
      'Понял вас, сайт нужен к запуску, давайте обсудим детали',
      'Договорились, жду вас завтра в 11',
      'Да. Хорошо. Жду',
      'Принял.\n\nЖду.\n\nСпасибо',
    ])
      expect(isShortReply(text), text).toBe(false)
  })

  it('FR-SPEECH-3: the thresholds are 5 words and 40 characters', () => {
    expect(isShortReply('Хорошо, давайте так и сделаем')).toBe(true)
    expect(isShortReply('Хорошо, давайте так и сделаем сегодня')).toBe(false)
    expect(isShortReply([w(7), w(7), w(7), w(7), w(8)].join(' '))).toBe(true)
    expect(isShortReply([w(7), w(7), w(7), w(7), w(9)].join(' '))).toBe(false)
    expect(isShortReply('Принял. Жду')).toBe(true)
    expect(isShortReply('Принял. Жду. Спасибо')).toBe(false)
  })

  it('FR-SPEECH-3: emoji are not counted as words or as characters', () => {
    expect(isShortReply(`${w(7)} ${w(7)} ${w(7)} ${w(7)} ${w(8)} 🤝🙏😊👍👍🏽`)).toBe(true)
  })
})

type VoiceInput = Parameters<typeof voiceIssues>[0]

const voice = (over: Partial<VoiceInput> = {}) =>
  voiceIssues({
    text: 'Анна, посмотрел задачу, сайт нужен к запуску',
    firstMessage: false,
    tone: null,
    badNews: false,
    ourPrevious: [],
    name: 'Анна',
    ...over,
  })
const voiceIds = (over: Partial<VoiceInput> = {}): VoiceIssueId[] => voice(over).map((i) => i.id)

describe('voiceIssues: a clean reply (FR-SPEECH-3)', () => {
  it("FR-SPEECH-3: a reply in Boris's voice has no issue", () => {
    expect(voice()).toEqual([])
    expect(
      voice({
        text: 'Анна, добрый день!\n\nПосмотрел задачу, сайт нужен к запуску?\n\nДоговорились 🤝',
        firstMessage: true,
        tone: 'neutral',
      }),
    ).toEqual([])
  })

  it('FR-SPEECH-3: an issue has a known id and a plain Russian detail without a long dash', () => {
    const issues = voice({
      text: 'Пришлю ссылку, поняла вас)))\n\nКто вы? Что нужно?',
      firstMessage: true,
      tone: 'irritation',
      badNews: true,
      ourPrevious: ['Пришлю ссылку, поняла вас)))'],
    })
    expect(issues.length).toBe(6)
    for (const i of issues) {
      expect(CHECK_IDS).toContain(i.id)
      expect(i.id.startsWith('voice.')).toBe(true)
      expect(i.detail).toMatch(/[а-яё]/i)
      expect(i.detail).not.toMatch(/[–—]/)
    }
    expect(new Set(issues.map((i) => i.id)).size).toBe(issues.length)
  })

  it('FR-SPEECH-3: an empty text has nothing to say', () => {
    expect(voice({ text: '' })).toEqual([])
  })
})

describe('voiceIssues: voice.promise_action (rule 12)', () => {
  it("FR-SPEECH-3: Boris's own actions promised in the reply are found", () => {
    for (const text of [
      'Анна, пришлю ссылку на примеры',
      'Анна, пришлю КП сегодня',
      'Анна, КП за два дня',
      'Анна, кп за 2 дня сделаем',
      'Анна, посмотрю сайт и напишу',
      'Анна, посмотрю ваш сайт',
      'Анна, веду лично',
      'Анна, буду вести проект лично',
      'Анна, подготовлю предложение',
      'Анна, скину презентацию',
      'Анна, вышлю расчёт',
      'Анна, отправлю договор',
      'Анна, сделаю расчёт стоимости',
      'Анна, изучу ваши соцсети',
      'Анна, составлю смету',
      'Анна, коммерческое предложение будет через два дня',
      'Анна, пришлём вам макет',
      'Анна, смету подготовим к пятнице',
      'Анна, займусь лично вашим проектом',
    ])
      expect(voiceIds({ text }), text).toContain('voice.promise_action')
  })

  it('FR-SPEECH-3: the detail quotes the promise', () => {
    const [issue] = voice({ text: 'Анна, пришлю ссылку на примеры' })
    expect(issue?.id).toBe('voice.promise_action')
    expect(issue?.detail).toContain('пришлю')
  })

  it("FR-SPEECH-3: Sara speaking and doing her own work is not a promise of Boris's action", () => {
    for (const text of [
      'Анна, сделаем сайт под ключ',
      'Анна, давайте обсудим детали',
      'Анна, уточню у Бориса и вернусь',
      'Анна, расскажу, как идёт работа',
      'Анна, сайт делаем за 2-3 недели',
      'Анна, посмотрим, что можно сделать',
      'Анна, КП обычно делаем по итогам созвона',
      'Анна, пришлите ссылку на ваш сайт',
      'Анна, вы пришлёте примеры?',
      'Анна, вы посмотрите сайт конкурента?',
      'Анна, спасибо, что отправили бриф',
      'Анна, напишу вам завтра',
      'Анна, посмотрю задачу и отвечу',
      'Анна, лично я бы выбрал первый вариант',
    ])
      expect(voiceIds({ text }), text).not.toContain('voice.promise_action')
  })
})

describe('voiceIssues: voice.many_questions (rule 14)', () => {
  it('FR-SPEECH-3: more than one question in the first message is an issue', () => {
    expect(
      voiceIds({ text: 'Анна, добрый день! Какой срок? Какой бюджет?', firstMessage: true }),
    ).toContain('voice.many_questions')
    expect(voiceIds({ text: 'Анна, что нужно?! Когда?!', firstMessage: true })).toContain(
      'voice.many_questions',
    )
  })

  it('FR-SPEECH-3: one question, a doubled mark, a link with a query or a later message is fine', () => {
    expect(voiceIds({ text: 'Анна, какой срок?', firstMessage: true })).toEqual([])
    expect(voiceIds({ text: 'Анна, какой срок??', firstMessage: true })).toEqual([])
    expect(
      voiceIds({ text: 'Анна, смотрите hance.ru/?a=1&b=2 какой срок?', firstMessage: true }),
    ).toEqual([])
    expect(voiceIds({ text: 'Анна, какой срок? Какой бюджет?', firstMessage: false })).toEqual([])
  })
})

describe('voiceIssues: voice.emoji_tone (rule 8)', () => {
  it('FR-SPEECH-3: the four emoji and one or two brackets are fine in an ordinary talk', () => {
    for (const text of [
      'Анна, договорились 🤝',
      'Анна, спасибо 🙏',
      'Анна, отлично 😊',
      'Анна, принял 👍',
      'Анна, принял 👍🏽',
      'Анна, спасибо 🙏🏻',
      'Анна, понял)',
      'Анна, понял))',
      'Анна, смотрите (пример ниже) и (второй)',
      'Анна, вот что нужно:\n1) Раз\n2) Два\n3) Три',
      'Анна, Hance™ делает сайты',
    ])
      expect(voiceIds({ text }), text).not.toContain('voice.emoji_tone')
  })

  it('FR-SPEECH-3: three or more brackets that close nothing are an issue', () => {
    expect(voiceIds({ text: 'Анна, понял)))' })).toContain('voice.emoji_tone')
    expect(voiceIds({ text: 'Анна, хорошо) договорились) жду)' })).toContain('voice.emoji_tone')
    expect(voiceIds({ text: 'Анна, смотрите (пример) :)))' })).toContain('voice.emoji_tone')
  })

  it('FR-SPEECH-3: any other emoji is an issue', () => {
    for (const e of ['🔥', '🚀', '😂', '❤️', '😉', '✅'])
      expect(voiceIds({ text: `Анна, отлично ${e}` }), e).toContain('voice.emoji_tone')
  })

  it('FR-SPEECH-3: no emoji and no bracket in a tense talk', () => {
    for (const tone of ['irritation', 'rudeness', 'hurry', 'doubt', 'bargaining'] as Tone[]) {
      expect(voiceIds({ text: 'Анна, понимаю 🙏', tone }), tone).toContain('voice.emoji_tone')
      expect(voiceIds({ text: 'Анна, понимаю)', tone }), tone).toContain('voice.emoji_tone')
      expect(voiceIds({ text: 'Анна, понимаю', tone }), tone).not.toContain('voice.emoji_tone')
    }
  })

  it('FR-SPEECH-3: a friendly or ordinary tone and an unknown tone allow the four emoji', () => {
    for (const tone of ['neutral', 'joke', 'compliment', null] as (Tone | null)[])
      expect(voiceIds({ text: 'Анна, договорились 🤝', tone }), String(tone)).toEqual([])
  })

  it('FR-SPEECH-3: no emoji and no bracket with bad news, in any tone', () => {
    expect(voiceIds({ text: 'Анна, к сожалению, не успеем 🙏', badNews: true })).toContain(
      'voice.emoji_tone',
    )
    expect(voiceIds({ text: 'Анна, к сожалению, не успеем)', badNews: true })).toContain(
      'voice.emoji_tone',
    )
    expect(
      voiceIds({ text: 'Анна, к сожалению, не успеем', badNews: true, tone: 'joke' }),
    ).not.toContain('voice.emoji_tone')
  })
})

describe('voiceIssues: voice.signature_repeat (rule 12)', () => {
  const previous = ['Анна, давайте обсудим детали на созвоне. Жду вашего ответа на этой неделе']

  it('FR-SPEECH-3: a sentence of four words or more that our earlier message already said is an issue', () => {
    expect(
      voiceIds({ text: 'Хорошо. Давайте обсудим детали на созвоне', ourPrevious: previous }),
    ).toContain('voice.signature_repeat')
    expect(
      voiceIds({ text: 'Жду ВАШЕГО ответа на этой неделе!', ourPrevious: previous }),
    ).toContain('voice.signature_repeat')
  })

  it("FR-SPEECH-3: letter case, ё, punctuation and the client's name do not hide a repeat", () => {
    expect(
      voiceIds({
        text: 'Анна, всё понятно, жду ваш ответ',
        ourPrevious: ['Все понятно жду ваш ответ!'],
      }),
    ).toContain('voice.signature_repeat')
  })

  it('FR-SPEECH-3: the detail quotes the repeated sentence', () => {
    const issue = voice({
      text: 'Хорошо. Давайте обсудим детали на созвоне',
      ourPrevious: previous,
    }).find((i) => i.id === 'voice.signature_repeat')
    expect(issue?.detail).toContain('Давайте обсудим детали на созвоне')
  })

  it('FR-SPEECH-3: a short sentence, another sentence or no earlier message is no repeat', () => {
    expect(voiceIds({ text: 'Анна, давайте обсудим детали', ourPrevious: previous })).toEqual([])
    expect(
      voiceIds({ text: 'Анна, давайте обсудим детали на созвоне завтра', ourPrevious: previous }),
    ).toEqual([])
    expect(voiceIds({ text: 'Анна, жду ответа', ourPrevious: previous })).toEqual([])
    expect(voiceIds({ text: 'Анна, давайте обсудим детали на созвоне', ourPrevious: [] })).toEqual(
      [],
    )
  })
})

describe('voiceIssues: voice.feminine (rule 7)', () => {
  it('FR-SPEECH-3: a feminine form spoken as Boris is an issue', () => {
    for (const text of [
      'Анна, поняла вас',
      'Анна, я посмотрела задачу',
      'Анна, подготовила для вас расчет',
      'Анна, заметила, что сайта пока нет',
      'Анна, сделала предварительный разбор',
      'Анна, я рада знакомству',
      'Анна, рада помочь',
      'Анна, я бы хотела уточнить',
      'Анна, вашу задачу посмотрела',
      'Анна, я уже договорилась с командой',
      'Анна, все поняла',
      'Анна, согласна, давайте так',
      'Анна, я очень благодарна за ответ',
    ])
      expect(voiceIds({ text }), text).toContain('voice.feminine')
  })

  it('FR-SPEECH-3: the detail quotes the form', () => {
    const issue = voice({ text: 'Анна, поняла вас' }).find((i) => i.id === 'voice.feminine')
    expect(issue?.detail).toContain('поняла')
  })

  it('FR-SPEECH-3: masculine, plural and third-person forms are not an issue', () => {
    for (const text of [
      'Анна, понял вас',
      'Анна, я посмотрел задачу',
      'Анна, поняли, спасибо',
      'Анна, вы уже посмотрели?',
      'Анна, рад знакомству',
      'Анна, наша команда сделала похожий проект',
      'Анна, студия подготовила для них расчёт',
      'Анна, компания заметила рост',
      'Анна, она поняла задачу',
      'Анна, смета готова',
      'Анна, работа готова к запуску',
      'Анна, школа, которая сделала сайт, довольна',
      'Анна, задача была в том, чтобы выросли заявки',
    ])
      expect(voiceIds({ text }), text).not.toContain('voice.feminine')
  })
})

describe('voiceIssues: voice.no_name (rule 6)', () => {
  it('FR-SPEECH-3: a substantive reply that does not start with the known name is an issue', () => {
    expect(voiceIds({ text: 'Понял вас, сайт нужен к запуску, давайте обсудим детали' })).toContain(
      'voice.no_name',
    )
    expect(voiceIds({ text: 'Добрый день! Посмотрел задачу, сайт нужен к запуску' })).toContain(
      'voice.no_name',
    )
    expect(voiceIds({ text: 'Доброе утро!\n\nПосмотрел задачу, сайт нужен к запуску' })).toContain(
      'voice.no_name',
    )
  })

  it('FR-SPEECH-3: a reply that starts with the name, or with a greeting that holds it, is fine', () => {
    for (const text of [
      'Анна, понял вас, сайт нужен к запуску, давайте обсудим детали',
      'Анна, добрый день!\n\nПосмотрел задачу, сайт нужен к запуску',
      'Доброго дня, Анна! Посмотрел задачу, сайт нужен к запуску',
    ])
      expect(voiceIds({ text }), text).not.toContain('voice.no_name')
  })

  it('FR-SPEECH-3: a short reply goes without the name', () => {
    for (const text of ['Принял', 'Договорились 🤝', 'Отлично, жду'])
      expect(voiceIds({ text }), text).toEqual([])
  })

  it('FR-SPEECH-3: without a known name there is nothing to demand', () => {
    for (const name of [null, '', 'Клиент'])
      expect(
        voiceIds({ text: 'Понял вас, сайт нужен к запуску, давайте обсудим детали', name }),
        String(name),
      ).toEqual([])
  })
})

describe('isBotQuestion (FR-SPEECH-3, rule 13)', () => {
  it('FR-SPEECH-3: a client asking whether he talks to a bot, a robot or an AI is found', () => {
    for (const text of [
      'Вы бот?',
      'Это бот?',
      'Я с роботом общаюсь?',
      'Вы нейросеть?',
      'Это ИИ отвечает?',
      'Вы живой человек?',
      'Вы робот?',
      'ты бот?',
      'Вы не бот?',
      'А вы случайно не бот?',
      'Вы что, бот?',
      'Это автоответчик?',
      'Это чат-бот?',
      'Вы ChatGPT?',
      'Это нейронка пишет?',
      'Вы AI?',
      'Вы человек или бот?',
      'Вы бот или человек',
      'Бот или человек?',
      'Мне отвечает человек или программа?',
      'Мне пишет бот?',
      'Меня консультирует ИИ?',
      'Я общаюсь с ботом?',
      'Я разговариваю с нейросетью?',
      'С кем я общаюсь, с человеком или с ботом?',
      'Вы настоящий человек?',
      'Вы реальный человек?',
      'Вы вообще живой?',
      'Там живой человек?',
      'Это живой человек пишет?',
      'Вы человек?',
      'Это автоматический ответ?',
      'Скажите, вы бот?',
      'Извините, а вы бот или человек?',
      'Здравствуйте, мне нужен сайт, вы бот?',
      'Спасибо за ответ. Это бот отвечает?',
      'ВЫ БОТ???',
      'Вы бот 🤔',
      'Это вы лично пишете или бот?',
      'Кто мне отвечает, человек?',
      'Ой, а это робот?',
      'Вы - бот?',
    ])
      expect(isBotQuestion(text), text).toBe(true)
  })

  it('FR-SPEECH-3: a question about a bot as a service or about a person in a business is not found', () => {
    for (const text of [
      'Чат-бот для записи делаете?',
      'Вы делаете чат-ботов?',
      'Вы чат-бот для записи делаете?',
      'Нужен бот для телеграма',
      'Хочу бота для записи клиентов',
      'Можно ли подключить ChatGPT к сайту?',
      'Вы работаете с нейросетями?',
      'Делаете ли вы сайты с ИИ?',
      'Это работа для программиста?',
      'Вы делаете ботов?',
      'Бот сможет принимать заказы?',
      'Это ИИ-сервис?',
      'Вы человек занятой, понимаю',
      'У вас живой человек отвечает на звонки?',
      'Нужен бот или человек на поддержку?',
      'Мне нужен бот или человек для поддержки клиентов',
      'Это программа для расчёта сметы?',
      'Нужна нейросеть для генерации картинок',
      'Расскажите про вашу команду',
      'Кто будет вести проект?',
      'Это человек из вашей команды?',
      'Вы делаете сайты?',
      'Сколько стоит сайт?',
      '',
    ])
      expect(isBotQuestion(text), text).toBe(false)
  })
})
