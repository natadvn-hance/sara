import { CHECK_IDS } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import {
  checkReplyText,
  extractNumbers,
  isNewMoscowDay,
  startsWithGreeting,
} from '../../src/conversation/check/codeChecks'
import type { CheckInput } from '../../src/conversation/types'

const LONG = String.fromCharCode(0x2014)
const MEDIUM = String.fromCharCode(0x2013)
const NBSP = '\u00a0'

const input = (over: Partial<CheckInput> = {}): CheckInput => ({
  text: 'Понимаю, сайт нужен к запуску.\n\nУдобно созвониться и обсудить детали?',
  move: 'reply',
  factIds: ['j-constitution', 'k-price-landing'],
  recalledIds: ['j-constitution', 'k-price-landing', 'k-cases', 'u-price-question'],
  knowledgeTexts: {
    'k-price-landing': 'Лендинг стоит от 50 000 рублей, делаем за 2-3 недели. Предоплата 30%.',
    'k-cases': 'Сайт клиники за 70 000 рублей.',
  },
  newDay: false,
  clientTurnText: 'Сколько стоит лендинг и как быстро сделаете?',
  ourPrevious: ['Добрый день! Понимаю задачу.\n\nКакой срок запуска для вас важен?'],
  bannedPhrases: [],
  ...over,
})
const ids = (over: Partial<CheckInput>) => checkReplyText(input(over)).map((x) => x.id)

describe('the code checks of a reply', () => {
  it('FR-CONV-4: a plain reply on the same day passes every check', () => {
    expect(checkReplyText(input())).toEqual([])
  })

  it('FR-CONV-4: a price not in the cited knowledge fails facts.numbers', () => {
    expect(checkReplyText(input({ text: 'Лендинг обойдётся в 90 000 рублей.' }))).toEqual([
      { id: 'facts.numbers', detail: 'число 90 000 не из разума' },
    ])
    // 70 000 is in a recalled record, but the reply does not cite it.
    expect(ids({ text: 'Сделаем за 70 000 рублей.' })).toEqual(['facts.numbers'])
  })

  it('FR-CONV-4: a number of the cited knowledge passes however its spaces and units are written', () => {
    for (const text of [
      'Лендинг от 50 000 рублей.',
      'Лендинг от 50000 рублей.',
      `Лендинг от 50${NBSP}000 рублей.`,
      'Лендинг от 50 тысяч рублей.',
      'Делаем за 2-3 недели, предоплата 30%.',
    ])
      expect(ids({ text })).toEqual([])
  })

  it('FR-CONV-4: a scale word does not turn a small number of the records into a price', () => {
    // The record says «Предоплата 30%» and «2-3 недели»: 30 thousand and 2 thousand are other numbers.
    expect(ids({ text: 'Реклама от 30 тысяч.' })).toEqual(['facts.numbers'])
    expect(ids({ text: 'Сделаем за 2 тысячи.' })).toEqual(['facts.numbers'])
    // The client's «3 точки» is not 3 thousand roubles.
    expect(ids({ text: 'Реклама от 3 тыс. рублей.', clientTurnText: 'Нужно 3 точки' })).toEqual([
      'facts.numbers',
    ])
    // A percent is not a plain number: 30% is not 30, and 30 is not 30%.
    expect(ids({ text: 'Предоплата 30 рублей.' })).toEqual(['facts.numbers'])
    expect(
      ids({
        text: 'Скидка 30%.',
        knowledgeTexts: { 'k-price-landing': 'Срок 30 дней.' },
      }),
    ).toEqual(['facts.numbers'])
    expect(ids({ text: 'Предоплата 30 процентов.' })).toEqual([])
  })

  it('FR-CONV-4: a scale word at the end of a range belongs to both numbers', () => {
    const knowledgeTexts = { 'k-price-landing': 'Лендинг стоит от 50 000 до 70 000 рублей.' }
    for (const text of [
      'Лендинг стоит 50-70 тысяч.',
      'Лендинг от 50 до 70 тысяч рублей.',
      'Лендинг 50-70 тыс.',
      'Лендинг 50 - 70 тыс. рублей.',
      'Лендинг от 50 или 70 тысяч рублей.',
    ])
      expect(ids({ text, knowledgeTexts }), text).toEqual([])
    // Each number keeps its own scale when it has one; a range of plain numbers stays plain.
    expect(ids({ text: 'Лендинг от 50 до 90 тысяч.', knowledgeTexts })).toEqual(['facts.numbers'])
    expect(ids({ text: 'Срок 2-3 недели.' })).toEqual([])
    expect(ids({ text: 'Срок 2-3 тысячи.' })).toEqual(['facts.numbers', 'facts.numbers'])
  })

  it('FR-CONV-4: a number the client named in this turn is allowed', () => {
    const text = 'Понимаю, бюджет 120 000.\n\nУдобно созвониться и обсудить детали?'
    expect(ids({ text, clientTurnText: 'Бюджет 120 000, успеете?' })).toEqual([])
    // Named before this turn, the number is not the client's word any more.
    expect(ids({ text, clientTurnText: 'А по срокам как?' })).toEqual(['facts.numbers'])
  })

  it('FR-CONV-4: times, dates, phones and small numbers inside words are not facts', () => {
    expect(
      extractNumbers(
        'В 15:30 или 9:00, 26.10 или 27.10.2026, тел. 8 (918) 123-45-67, +7 918 123 45 67, 89181234567, 123-45-67, +375 29 123-45-67, B2B, 3D, 1С',
      ),
    ).toEqual([])
    expect(extractNumbers('От 50 000 ₽, срок 2-3 недели, предоплата 30%, 1,5 месяца')).toEqual([
      '50 000',
      '2',
      '3',
      '30%',
      '1,5',
    ])
  })

  it('FR-CONV-4: an invented time, date or phone in a reply fails facts.numbers', () => {
    for (const text of [
      'Встретимся 27.10 в 15:00 в офисе.',
      'Сделаем к 01.11.',
      'Наш телефон 8 918 123-45-67.',
      'Звоните по 123-45-67.',
      'Работаем с 9:00 до 18:00.',
      'Скидка 10-15-20%.',
    ])
      expect(ids({ text }), text).toContain('facts.numbers')
    // «в 3 дня» is a term, not a clock time, so it is a plain number: not in the record, it fails.
    expect(
      ids({
        text: 'Сделаем лендинг в 3 дня.',
        knowledgeTexts: { 'k-price-landing': 'Лендинг от 50 000 рублей.' },
      }),
    ).toEqual(['facts.numbers'])
    // The reason says what it was, not a bare digit.
    expect(
      checkReplyText(input({ text: 'Встретимся 27.10 в 15:00.' })).map((x) => x.detail),
    ).toEqual(expect.arrayContaining(['дата 27.10 не из разума', 'время 15:00 не из разума']))
    expect(checkReplyText(input({ text: 'Наш телефон 8 918 123-45-67.' }))[0]?.detail).toBe(
      'телефон 8 918 123-45-67 не из разума',
    )
  })

  it('FR-CONV-4: a phone, a time or a date the client named, or the cited knowledge holds, passes', () => {
    // The same phone written another way, the same time and day.
    expect(
      ids({
        text: 'Записала ваш номер 8 (918) 123-45-67, передам Борису.',
        clientTurnText: 'Мой номер +79181234567',
      }),
    ).toEqual([])
    expect(
      ids({ text: 'Поняла, в 15:00 вам удобно.', clientTurnText: 'Могу завтра в 15:00' }),
    ).toEqual([])
    expect(ids({ text: 'До 27.10 успеем.', clientTurnText: 'Нужно к 27.10' })).toEqual([])
    const knowledgeTexts = {
      'k-price-landing': 'Работаем с 9:00 до 18:00, мини-лендинг за 3 дня.',
    }
    expect(ids({ text: 'Мы работаем с 9:00 до 18:00.', knowledgeTexts })).toEqual([])
    expect(ids({ text: 'Мини-лендинг сделаем в 3 дня.', knowledgeTexts })).toEqual([])
    // A phone in the records is not the client's: only what they wrote or the cited record holds.
    expect(ids({ text: 'Наш телефон 8 800 555-35-35.' })).toEqual(['facts.numbers'])
    expect(
      ids({
        text: 'Наш телефон 8 800 555-35-35.',
        knowledgeTexts: { 'k-price-landing': 'Бесплатная линия: 8 (800) 555-35-35' },
      }),
    ).toEqual([])
  })

  it('FR-CONV-3: a reply without any mind id fails facts.none', () => {
    expect(checkReplyText(input({ factIds: [] }))).toEqual([
      { id: 'facts.none', detail: 'в ответе нет ни одного номера записи разума' },
    ])
  })

  it('FR-CONV-4: a cited id that was not recalled fails facts.unknown', () => {
    expect(checkReplyText(input({ factIds: ['j-constitution', 'k-made-up'] }))).toEqual([
      { id: 'facts.unknown', detail: 'номер k-made-up не из отобранных записей' },
    ])
  })

  it('FR-CONV-4: a new Moscow day needs a greeting, the same day forbids it', () => {
    // 23:50 and 00:10 by Moscow are one UTC day, two Moscow days.
    expect(isNewMoscowDay('2026-10-24T20:50:00.000Z', new Date('2026-10-24T21:10:00.000Z'))).toBe(
      true,
    )
    // 00:10 and 23:50 of one Moscow day are two UTC days.
    expect(isNewMoscowDay('2026-10-24T21:10:00.000Z', new Date('2026-10-25T20:50:00.000Z'))).toBe(
      false,
    )
    expect(isNewMoscowDay(null, new Date('2026-10-25T09:00:00.000Z'))).toBe(true)

    const greeted = 'Анна, здравствуйте!\n\nУдобно созвониться и обсудить детали?'
    const plain = 'Удобно созвониться и обсудить детали?'
    expect(checkReplyText(input({ newDay: true, text: plain }))).toEqual([
      { id: 'greeting.missing', detail: 'нет приветствия, а сегодня новый день' },
    ])
    expect(ids({ newDay: true, text: greeted })).toEqual([])
    expect(checkReplyText(input({ newDay: false, text: greeted }))).toEqual([
      { id: 'greeting.extra', detail: 'снова приветствие, а сегодня уже здоровались' },
    ])
  })

  it('FR-CONV-4: a greeting may come with the name before or after it', () => {
    for (const t of [
      'Анна, здравствуйте!',
      'Добрый день, Анна!',
      'Здравствуйте!',
      'Доброе утро. Посмотрел',
      'добрый вечер',
      '  Добрый день!',
      '[имя 1], добрый день!',
    ])
      expect(startsWithGreeting(t), t).toBe(true)
    for (const t of ['Приветливый персонал решает', 'Понимаю вас.', 'Анна, понимаю вас.', ''])
      expect(startsWithGreeting(t), t).toBe(false)
  })

  it('FR-CONV-4: a long or medium dash anywhere fails', () => {
    for (const dash of [LONG, MEDIUM])
      expect(checkReplyText(input({ text: `Понимаю ${dash} это важно.` }))).toEqual([
        { id: 'dash', detail: 'длинное или среднее тире' },
      ])
  })

  it('FR-CONV-4: Sara never promises to call', () => {
    for (const text of [
      'Я вам перезвоню завтра.',
      'Наберу вас после обеда.',
      'Давайте я вам позвоню?',
      'Свяжусь с вами по телефону.',
      'Могу вам позвонить?',
      'Мы вам перезвоним.',
      'Созвонимся в 15:00?',
      'Давайте созвонимся в 11 утра.',
    ])
      expect(ids({ text, clientTurnText: 'Могу в 15:00 или в 11 утра' }), text).toEqual([
        'promise.call',
      ])
    for (const text of [
      'Удобно созвониться?',
      'Давайте созвонимся, когда вам удобно?',
      'Во сколько вам удобно созвониться?',
    ])
      expect(ids({ text }), text).toEqual([])
  })

  it('FR-CONV-4: promising that Boris calls, or naming a day or an hour for a call or a meeting, is promise.call', () => {
    for (const text of [
      'Борис вам позвонит завтра.',
      'Борис перезвонит вам сегодня.',
      'Готова позвонить в любое время.',
      'Готов вам позвонить, когда скажете.',
      'С вами свяжется Борис по телефону.',
      'По телефону с вами свяжется Борис.',
      'Сделаю звонок, как освободитесь.',
      'Назначу встречу с Борисом.',
      'Давайте созвонимся завтра после обеда.',
      'Созвонимся в понедельник?',
      'Встретимся в 15:00.',
      'Встретимся на этой неделе?',
    ])
      expect(ids({ text, clientTurnText: 'Давайте в 15:00' }), text).toContain('promise.call')
    // Inviting without a time is still fine, and so is a word about calls that is not a call to make.
    for (const text of [
      'Борис сам со всем разберётся, удобно созвониться?',
      'Хорошо, предложу встречу, когда вам удобно?',
      'Сколько звонков приходит с 9:00 до 18:00?',
      'Сегодня у нас в работе три сайта.',
    ])
      expect(ids({ text, clientTurnText: 'Мы работаем 9:00-18:00' }), text).toEqual([])
  })

  it('FR-CONV-4: banned phrases from the portrait are robotic', () => {
    expect(
      checkReplyText(input({ text: 'Понимаю. Всего доброго!', bannedPhrases: ['Всего доброго'] })),
    ).toEqual([{ id: 'robotic.phrase', detail: 'роботная фраза «Всего доброго»' }])
    // Case and ё do not hide a phrase, and «Буду рада» is not also «Буду рад».
    expect(ids({ text: 'Все получится.', bannedPhrases: ['Всё получится'] })).toEqual([
      'robotic.phrase',
    ])
    expect(ids({ text: 'Буду рада обсудить.' })).toEqual(['robotic.phrase'])
    expect(ids({ text: 'Отличный вопрос! Надеюсь это поможет.' })).toEqual([
      'robotic.phrase',
      'robotic.phrase',
    ])
    expect(ids({ text: 'Радость клиента важна.' })).toEqual([])
  })

  it('FR-CONV-4: Sara never speaks of herself as a program', () => {
    for (const text of [
      'Я бот, но помогу.',
      'Как ИИ, я не могу.',
      'Это пишет искусственный интеллект.',
      'Ответила нейросеть.',
      'Я языковая модель.',
      'Я программа.',
      'Я Claude, модель от Anthropic.',
      'Я ChatGPT.',
      'Я виртуальный ассистент.',
      'Я ваш помощник по сайту.',
      'Это автоматический ответ.',
      'Я не человек.',
      'Мы бот агентства.',
      'Вам отвечает бот.',
    ])
      expect(ids({ text }), text).toEqual(['robotic.ai'])
  })

  it('FR-CONV-4: talking about bots and neural networks as work is not talking about herself', () => {
    for (const text of [
      'Чат-бот для записи тоже делаем.',
      'Тексты пишем без нейросетей.',
      'Да, нейросети используем для креативов.',
      'Мы делаем чат-боты и сайты.',
      'Мы помощники в продвижении сайтов.',
      'Объясню, как алгоритм подбирает показы.',
      'Автоматические сообщения для записи клиентов настроим.',
      'Я программирую только в команде.',
    ])
      expect(ids({ text }), text).toEqual([])
    // A model's name is allowed only when the client wrote it in this turn.
    const text = 'Интеграцию с ChatGPT делаем.'
    expect(ids({ text })).toEqual(['robotic.ai'])
    expect(ids({ text, clientTurnText: 'Нужна интеграция с ChatGPT' })).toEqual([])
    // But the client asking does not let Sara say what she is.
    expect(ids({ text: 'Я не бот.', clientTurnText: 'Вы бот?' })).toEqual(['robotic.ai'])
  })

  it('FR-CONV-4: lists and markup are robotic', () => {
    for (const text of ['Есть два пути:\n1. Сайт\n2. Реклама', '- сайт', '• сайт', '* сайт'])
      expect(ids({ text }), text).toEqual(['robotic.list'])
    for (const text of ['Это **важно**.', '# Итог', 'Поле `title`.'])
      expect(ids({ text }), text).toEqual(['robotic.markup'])
  })

  it('FR-CONV-4: a reply too long for the client turn is robotic', () => {
    const words = (n: number) => 'слово '.repeat(n).trim()
    expect(ids({ text: words(101), clientTurnText: 'Расскажите подробнее' })).toEqual([
      'robotic.length',
    ])
    const turn = 'Нам нужен лендинг для курсов английского языка'
    expect(turn.length).toBeGreaterThan(40)
    expect(ids({ text: words(4 * 8), clientTurnText: turn })).toEqual(['robotic.length'])
    expect(ids({ text: words(4 * 7), clientTurnText: turn })).toEqual([])
    expect(ids({ text: words(50), clientTurnText: 'Короче?' })).toEqual([])
  })

  it('FR-CONV-4: repeating our message or quoting the client is robotic', () => {
    const ourPrevious = ['Подскажите, какой срок запуска для вас важен и есть ли уже сайт?']
    expect(
      ids({ ourPrevious, text: 'Понимаю. Какой срок запуска для вас важен и когда старт?' }),
    ).toEqual([])
    expect(
      checkReplyText(
        input({
          ourPrevious,
          text: 'Понимаю. Какой срок запуска для вас важен и есть ли уже сайт?',
        }),
      ),
    ).toEqual([
      {
        id: 'robotic.repeat',
        detail: 'повтор прошлого сообщения: «какой срок запуска для вас важен и есть»',
      },
    ])
    const clientTurnText = 'Нам нужен лендинг для курсов английского языка, срочно'
    expect(ids({ clientTurnText, text: 'Понимаю, лендинг для курсов английского нужен.' })).toEqual(
      [],
    )
    expect(
      checkReplyText(
        input({ clientTurnText, text: 'Понимаю, нужен лендинг для курсов английского языка.' }),
      ),
    ).toEqual([
      {
        id: 'robotic.quote',
        detail: 'дословно из слов клиента: «нужен лендинг для курсов английского языка»',
      },
    ])
  })

  it('FR-CONV-4: move none and call_boris need no text', () => {
    expect(checkReplyText(input({ move: 'none', text: null, factIds: [] }))).toEqual([])
    expect(checkReplyText(input({ move: 'call_boris', text: null, factIds: [] }))).toEqual([])
    expect(checkReplyText(input({ move: 'reply', text: null }))).toEqual([
      { id: 'empty', detail: 'ход «ответить», а текста нет' },
    ])
    expect(ids({ move: 'reply', text: '  \n ' })).toEqual(['empty'])
  })

  it('FR-CONV-4: every problem of a reply is found, not only the first', () => {
    const issues = checkReplyText(
      input({ newDay: true, factIds: [], text: `Отличный вопрос ${LONG} лендинг за 90 000.` }),
    )
    expect(issues.map((x) => x.id).sort()).toEqual(
      ['dash', 'facts.none', 'facts.numbers', 'greeting.missing', 'robotic.phrase'].sort(),
    )
    for (const x of issues) expect(CHECK_IDS).toContain(x.id)
  })
})
