import { describe, expect, it } from 'vitest'
import { fixClientText } from '../../src/text/clientText'

// Long and medium dashes are written by code, never typed (CI forbids the long one in files).
const LONG = String.fromCharCode(0x2014)
const MEDIUM = String.fromCharCode(0x2013)
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
