import { describe, expect, it } from 'vitest'
import {
  fixClientText,
  greetingFor,
  HYPHEN_NAMES,
  isGreetingForm,
  leadingGreeting,
  moscowPartOfDay,
} from '../../src/text/clientText'

// Long and medium dashes are written by code, never typed (CI forbids the long one in files).
const LONG = String.fromCharCode(0x2014)
const MEDIUM = String.fromCharCode(0x2013)
const ANY_DASH = new RegExp(`[${MEDIUM}${LONG}]`)
const NBSP = ' '

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

  it('NFR-UX-1: a hyphen in a Latin-only brand word keeps', () => {
    expect(fixClientText('Подключим Wi-Fi и A-Store')).toBe('Подключим Wi-Fi и A-Store')
    expect(fixClientText('Нужен e-mail и T-Bank')).toBe('Нужен e-mail и T-Bank')
    expect(fixClientText('Смотрите B2B-SaaS и Web3-Wallet')).toBe('Смотрите B2B-SaaS и Web3-Wallet')
  })

  it('NFR-UX-1: a word of Latin and Cyrillic loses its hyphen like any common word (Boris writes «B2B компании»)', () => {
    expect(fixClientText('Делаем Telegram-бот и SEO-продвижение')).toBe(
      'Делаем Telegram бот и SEO продвижение',
    )
    expect(fixClientText('Работаем с B2B-сегментом и CRM-системой')).toBe(
      'Работаем с B2B сегментом и CRM системой',
    )
    expect(fixClientText('Нужен Instagram-аккаунт, SMM-стратегия и iPhone-чехол')).toBe(
      'Нужен Instagram аккаунт, SMM стратегия и iPhone чехол',
    )
    expect(fixClientText('Бот-Telegram и Яндекс-Direct')).toBe('Бот Telegram и Яндекс Direct')
  })

  it('NFR-UX-1: a name of the list keeps its hyphen, in any case form', () => {
    expect(fixClientText('Мы партнёры 1С:Франчайзи и работаем с 1С-Битрикс')).toBe(
      'Мы партнёры 1С:Франчайзи и работаем с 1С-Битрикс',
    )
    expect(fixClientText('Офис в санкт-петербурге, клиент из ростова-на-дону')).toBe(
      'Офис в санкт-петербурге, клиент из ростова-на-дону',
    )
    expect(fixClientText('Из Нью-Йорка и в Нью-Йорке')).toBe('Из Нью-Йорка и в Нью-Йорке')
  })

  it('NFR-UX-1: the list of names is one exported constant of whole names', () => {
    for (const name of ['Санкт-Петербург', 'Ростов-на-Дону', 'Нью-Йорк', 'Wi-Fi', '1С:Франчайзи'])
      expect(HYPHEN_NAMES, name).toContain(name)
    for (const name of HYPHEN_NAMES)
      expect(fixClientText(`У нас ${name} есть`), name).toContain(name)
  })

  it('NFR-UX-1: numbers keep their hyphens: ranges are not rewritten, dates and a number with an ending stay', () => {
    expect(fixClientText('Через 2-3 недели, скидка 10-15%, 5-летний опыт, 2-й этап')).toBe(
      'Через 2-3 недели, скидка 10-15%, 5-летний опыт, 2-й этап',
    )
    expect(fixClientText('Встреча 26-10-2026, с 9:00-18:00, на 100-200 человек')).toBe(
      'Встреча 26-10-2026, с 9:00-18:00, на 100-200 человек',
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
    expect(out).not.toMatch(ANY_DASH)
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

  it('FR-SPEECH-3: a name before the greeting takes the morning, the day and the evening alike («Татьяна, доброе утро!»)', () => {
    for (const text of [
      'Татьяна, доброе утро!',
      'Татьяна, добрый день!',
      'Татьяна, добрый вечер!',
      'Татьяна,доброе утро!',
      'Татьяна, Доброе утро!',
    ])
      expect(isGreetingForm(text), text).toBe(true)
    expect(isGreetingForm('Татьяна, доброе утро!', new Date('2026-10-26T08:59:00Z'))).toBe(true)
    expect(isGreetingForm('Татьяна, добрый вечер!', new Date('2026-10-26T15:00:00Z'))).toBe(true)
    expect(isGreetingForm('Татьяна, доброе утро!', new Date('2026-10-26T15:00:00Z'))).toBe(false)
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
