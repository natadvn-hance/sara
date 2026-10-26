import { type CaseChoice, CHECK_IDS } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { namesCase } from '../../src/conversation/check/caseChecks'
import {
  checkReplyText,
  extractNumbers,
  isNewMoscowDay,
  startsWithGreeting,
} from '../../src/conversation/check/codeChecks'
import type { CaseHit, CheckInput } from '../../src/conversation/types'

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

  it('FR-CONV-4: a text written with a move that is not a reply is not checked, it is never sent', () => {
    const text = `Отличный вопрос ${LONG} лендинг за 90 000. Я бот.`
    expect(checkReplyText(input({ move: 'call_boris', text, factIds: [] }))).toEqual([])
    expect(checkReplyText(input({ move: 'none', text, factIds: [] }))).toEqual([])
    expect(checkReplyText(input({ move: 'reply', text, factIds: [] })).length).toBeGreaterThan(0)
  })

  it('FR-CONV-4: «топ-10» and «x2» are numbers that need a source, «3D» and «B2B» are names', () => {
    for (const text of [
      'Выведем в топ-10 за месяц.',
      'Рост x7 за год.',
      'Рост х7 за год.',
      'Рост 7x за год.',
      'Рост 7× за год.',
    ])
      expect(ids({ text }), text).toEqual(['facts.numbers'])
    for (const text of ['Делаем 3D и B2B сайты.', 'Работаем с 1С.'])
      expect(ids({ text }), text).toEqual([])
    // The client wrote it, or the record holds it: it is allowed.
    expect(ids({ text: 'Выведем в топ-10.', clientTurnText: 'Хочу в топ-10' })).toEqual([])
    expect(
      ids({
        text: 'Рост x7 бывает.',
        knowledgeTexts: { 'k-price-landing': 'Кейс: рост х7 за полгода.' },
      }),
    ).toEqual([])
  })

  it('FR-CONV-4: only a markdown heading, bold or code is markup, a hashtag is not', () => {
    for (const text of ['# Итог', 'Тема:\n## Итог\nТекст', 'Это **важно**.', 'Поле `title`.'])
      expect(ids({ text }), text).toEqual(['robotic.markup'])
    for (const text of [
      'Хештег #кофейня подойдёт.',
      'Подпишем #кофейня и #чай.',
      'Знак # в конце #',
    ])
      expect(ids({ text }), text).toEqual([])
  })

  it('FR-CONV-4: a name before the greeting may end with an exclamation mark, a plain opener is no name', () => {
    for (const t of [
      'Анна! Здравствуйте',
      'Анна Петровна, здравствуйте!',
      'Анна. Добрый день',
      'Здравствуйте, Анна',
    ])
      expect(startsWithGreeting(t), t).toBe(true)
    for (const t of [
      'Понимаю, добрый день у вас был',
      'Конечно, добрый день бывает разный',
      'Спасибо, здравствуйте не нужно',
      'Хорошо! Добрый день',
    ])
      expect(startsWithGreeting(t), t).toBe(false)
  })

  it('FR-CONV-4: two UTC days can be one Moscow day and the day is compared as a date, not as a string', () => {
    // 21:00 UTC is midnight in Moscow: 20:59 and 21:00 are two Moscow days.
    expect(isNewMoscowDay('2026-10-24T20:59:00.000Z', new Date('2026-10-24T21:00:00.000Z'))).toBe(
      true,
    )
    expect(isNewMoscowDay('2026-10-24T21:00:00.000Z', new Date('2026-10-25T20:59:00.000Z'))).toBe(
      false,
    )
    // A year and a month change: 31 December to 1 January, 30 September to 1 October.
    expect(isNewMoscowDay('2026-12-31T10:00:00.000Z', new Date('2027-01-01T10:00:00.000Z'))).toBe(
      true,
    )
    expect(isNewMoscowDay('2026-09-30T10:00:00.000Z', new Date('2026-10-01T10:00:00.000Z'))).toBe(
      true,
    )
    // A broken date counts as a new day.
    expect(isNewMoscowDay('not a date', new Date('2026-10-25T10:00:00.000Z'))).toBe(true)
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

describe('cases in a reply', () => {
  const caseHit = (o: Partial<CaseHit> & Pick<CaseHit, 'id' | 'title'>): CaseHit => ({
    type: 'knowledge',
    scope: 'shared',
    body: '',
    topic: null,
    tones: [],
    stages: [],
    exampleClient: null,
    exampleBoris: null,
    rank: 1,
    summary: '',
    result: null,
    showRules: [],
    nameOpen: true,
    numbersOpen: false,
    ...o,
  })
  // Invented cases in the format of the mind's case records.
  const CEILINGS = caseHit({
    id: 'k-case-01',
    title: 'Потолок-Арт: подвесные потолки, Санкт-Петербург',
    summary: 'Построили для Потолок-Арт поток заявок через сайт и Яндекс Директ.',
    result: '90 заявок за первый месяц при бюджете рекламы 40 000 ₽.',
    showRules: ['Компанию и ссылку можно называть.', 'Цифры из «Результата» можно называть.'],
    numbersOpen: true,
  })
  const CLINIC = caseHit({
    id: 'k-case-02',
    title: 'Сеть стоматологий: онлайн-запись, Краснодар',
    summary: 'Перевели запись пациентов со звонков на онлайн-форму.',
    result: 'Заявок стало в полтора раза больше, 150 записей за два месяца.',
    showRules: ['Компанию не называть: NDA.'],
    nameOpen: false,
  })
  const SKYROOM = caseHit({
    id: 'k-case-03',
    title: 'SkyRoom: аренда студий, Москва',
    summary: 'Собрали сайт аренды студий.',
    showRules: ['Компанию не называть: NDA.'],
    nameOpen: false,
  })
  const DANCE = caseHit({
    id: 'k-case-04',
    title: 'Школа танцев: стратегия маркетинга',
    summary: 'Разработали стратегию маркетинга для школы танцев.',
    showRules: ['Компанию можно называть.'],
  })
  const WINDOWS = caseHit({
    id: 'k-case-05',
    title: 'Окна-Мастер: сайт и заявки, Москва',
    summary: 'Сделали сайт и заявки для оконной компании.',
  })
  const ASKED = { moment: 'asked', case_id: null, why: 'Клиент спросил о примерах' } as const
  const choose = (hit: CaseHit, moment: CaseChoice['moment'] = 'asked'): CaseChoice => ({
    moment,
    case_id: hit.id,
    why: 'Клиент спросил о примерах',
  })
  const withCases = (
    text: string,
    c: { offered?: CaseHit[]; told?: { id: string; title: string }[]; choice?: CaseChoice | null },
    over: Partial<CheckInput> = {},
  ) =>
    ids({
      text,
      cases: { offered: c.offered ?? [], told: c.told ?? [], choice: c.choice ?? null },
      ...over,
    })

  it('FR-CONV-4: a case not in the library fails as an invented case', () => {
    // An id that is not among the cases of this turn.
    expect(
      withCases('Делали похожее для клиники.', {
        offered: [CEILINGS],
        choice: { ...ASKED, case_id: 'k-case-99' },
      }),
    ).toEqual(['case.unknown'])
    // A story of a past project with no case chosen, or none offered at all.
    for (const text of [
      'Да, мы делали сайт для трёх студий йоги, у одной запись выросла вдвое.',
      'У нас был похожий проект для клиники.',
      'Один из наших клиентов тоже начинал с директа.',
      'Работали с похожей школой, всё получилось.',
    ])
      expect(withCases(text, { offered: [CEILINGS] }), text).toEqual(['case.unknown'])
    // A real one chosen, and work talk that tells no case, pass.
    expect(
      withCases('Делали для Потолок-Арт, заявки пошли через сайт.', {
        offered: [CEILINGS],
        choice: choose(CEILINGS),
      }),
    ).toEqual([])
    for (const text of [
      'Лендинг делаем за 2-3 недели.',
      'Делаем сайты и настраиваем рекламу.',
      'Понимаю, сайт нужен к запуску.',
    ])
      expect(withCases(text, { offered: [CEILINGS] }), text).toEqual([])
  })

  it('FR-CONV-4: a question to the client, a general remark and a negation are no story of a project', () => {
    for (const text of [
      'А вы раньше работали с подрядчиками по рекламе?',
      'Что уже делали для продвижения?',
      'Вы уже запускали для этого рекламу в Директе?',
      'Вы сами вели проект?',
      'Расскажите, что уже делали для продвижения?',
      'Для большинства наших клиентов первый шаг это аудит.',
      'Мы не делали такого раньше.',
      'У нас не было такого клиента.',
      'Раньше с такими не работали.',
      'Никогда не запускали рекламу без аудита.',
      'Лендинг делаем за 2-3 недели.',
      'Делаем сайты и настраиваем рекламу.',
    ])
      expect(withCases(text, { offered: [CEILINGS] }), text).toEqual([])
  })

  it('FR-CONV-4: an invented story of a project fails as an unknown case, also when a question follows it', () => {
    for (const text of [
      'Сделали похожее для стоматологии в Краснодаре, заявки пошли.',
      'Недавно помогли автосервису запустить рекламу.',
      'Была у нас клиника, начинали с одного канала.',
      'Один клиент из Краснодара тоже начинал с директа.',
      'У клиента с похожим бюджетом начинали с одного канала.',
      'Сделали похожее для стоматологии, хотите посмотреть?',
      'Мы запускали такое для кофейни, получилось хорошо.',
      'Наш клиент начинал с одного канала и дошёл до трёх.',
      'У нас был клиент с похожей задачей.',
      'Вывели в топ интернет-магазин из Сочи.',
    ])
      expect(withCases(text, { offered: [CEILINGS] }), text).toEqual(['case.unknown'])
    // The same with no case offered at all.
    expect(withCases('Помогли автосервису запустить рекламу.', {})).toEqual(['case.unknown'])
  })

  it('FR-CONV-4: with a case chosen, a story of another project outside its sentence fails', () => {
    const told = (text: string, hit = CEILINGS) =>
      withCases(text, { offered: [hit], choice: choose(hit) })
    // The sentence of the chosen case, and the sentences that go on with it, pass.
    expect(told('Делали для Потолок-Арт, заявки пошли через сайт.')).toEqual([])
    expect(told('Делали для Потолок-Арт. Запустили рекламу в Директе и собрали сайт.')).toEqual([])
    // A second story, by its own words or by the next sentence, does not.
    for (const text of [
      'Делали для Потолок-Арт, заявки пошли. Ещё делали сайт для трёх студий йоги, у одной запись выросла вдвое.',
      'Делали для Потолок-Арт, заявки пошли. Один клиент из Краснодара тоже так начинал.',
      'Недавно помогли автосервису запустить рекламу. Делали для Потолок-Арт, заявки пошли.',
      'Делали для Потолок-Арт. Удобно созвониться? Сделали похожее для стоматологии в Краснодаре.',
    ])
      expect(told(text), text).toEqual(['case.unknown'])
    // A case with no brand name is told by its first sentence of work, the next stories are others.
    expect(told('Делали для сети стоматологий: запись перевели на онлайн.', CLINIC)).toEqual([])
    expect(
      told('Делали для сети стоматологий. Ещё помогли автосервису запустить рекламу.', CLINIC),
    ).toEqual(['case.unknown'])
    // The word of a question about the client's work is still no story.
    expect(told('Делали для Потолок-Арт, заявки пошли. А вы раньше запускали рекламу?')).toEqual([])
  })

  it('FR-CONV-4: a case without a moment, a second case and a repeated case fail', () => {
    expect(
      withCases('Делали для Потолок-Арт, заявки пошли.', {
        offered: [CEILINGS],
        choice: choose(CEILINGS, null),
      }),
    ).toEqual(['case.no_moment'])
    // Two cases of the library in one text (told by their brand names; a descriptive title names no case).
    expect(
      withCases('Делали для Потолок-Арт и для Окна-Мастер.', {
        offered: [CEILINGS, WINDOWS],
        choice: choose(CEILINGS),
      }),
    ).toEqual(['case.many'])
    // Already told: the id again, its name in the text, or its name in what our side wrote before.
    const told = [{ id: CEILINGS.id, title: CEILINGS.title }]
    expect(withCases('Делали для Потолок-Арт.', { told, choice: choose(CEILINGS) })).toEqual([
      'case.repeat',
    ])
    expect(withCases('Как у Потолок-Арт, заявки пошли.', { told })).toContain('case.repeat')
    expect(
      withCases(
        'Делали для Потолок-Арт, заявки пошли через сайт.',
        { offered: [CEILINGS], choice: choose(CEILINGS) },
        { ourPrevious: ['Делали похожее для Потолок-Арт, помню.'] },
      ),
    ).toEqual(['case.repeat'])
  })

  it('FR-CONV-4: numbers of a case not open to clients and the name of a closed company fail', () => {
    // 150 records: the case does not allow numbers (and the facts check also knows it is not a source).
    const closedNumbers = withCases('Делали для сети стоматологий: 150 записей за два месяца.', {
      offered: [CLINIC],
      choice: choose(CLINIC),
    })
    expect(closedNumbers).toContain('case.closed')
    // A descriptor is not a name: «сети стоматологий» is what the case is called and may be told.
    expect(
      withCases('Делали для сети стоматологий: запись перевели на онлайн.', {
        offered: [CLINIC],
        choice: choose(CLINIC),
      }),
    ).toEqual([])
    // A brand under NDA.
    expect(
      withCases('Делали для SkyRoom, там аренда студий.', {
        offered: [SKYROOM],
        choice: choose(SKYROOM),
      }),
    ).toContain('case.closed')
    expect(
      withCases('Делали для студии аренды, собрали сайт.', {
        offered: [SKYROOM],
        choice: choose(SKYROOM),
      }),
    ).toEqual([])
    // Numbers of an open case are the case's own: the facts check takes them from it.
    expect(
      withCases('Делали для Потолок-Арт: 90 заявок за первый месяц.', {
        offered: [CEILINGS],
        choice: choose(CEILINGS),
      }),
    ).toEqual([])
    // But an open case does not make other numbers facts.
    expect(
      withCases('Делали для Потолок-Арт: 900 заявок за первый месяц.', {
        offered: [CEILINGS],
        choice: choose(CEILINGS),
      }),
    ).toEqual(['facts.numbers'])
  })

  it('FR-CONV-4: an abbreviation in the name of a case is no brand: «для компании под NDA, без названия» passes', () => {
    const NDA = caseHit({
      id: 'k-case-18',
      title: 'Компания под NDA',
      summary: 'Сделали сайт и настроили рекламу.',
      showRules: ['Компанию не называть: NDA.'],
      nameOpen: false,
    })
    const B2B = caseHit({
      id: 'k-case-22',
      title: 'B2B-компания под NDA',
      summary: 'Выстроили систему продаж.',
      showRules: ['Компанию не называть: NDA.'],
      nameOpen: false,
    })
    const HORECA = caseHit({
      id: 'k-case-05',
      title: 'A/B Company: аудиобрендинг для HoReCa',
      summary: 'Собрали аудиобрендинг для HoReCa.',
      showRules: ['Компанию не называть: NDA.'],
      nameOpen: false,
    })
    const FUNNEL = caseHit({
      id: 'k-case-23',
      title: 'SaaS-сервис: CRM, SEO и SMM',
      summary: 'Выстроили воронку.',
      showRules: ['Компанию не называть: NDA.'],
      nameOpen: false,
    })
    for (const [c, text] of [
      [NDA, 'Делали для компании под NDA, без названия: сайт и реклама.'],
      [B2B, 'Делали для B2B-компании под NDA, название не скажу.'],
      [HORECA, 'Делали аудиобрендинг для HoReCa, там помогли A/B тесты.'],
      [FUNNEL, 'Делали для SaaS, настроили CRM, SEO и SMM.'],
    ] as const)
      expect(withCases(text, { offered: [c], choice: choose(c) }), text).toEqual([])
    // A real brand next to an abbreviation is still closed.
    const SKY: CaseHit = { ...SKYROOM, title: 'SkyRoom: студии для B2B под NDA' }
    expect(
      withCases('Делали для SkyRoom, B2B.', { offered: [SKY], choice: choose(SKY) }),
    ).toContain('case.closed')
  })

  // The titles of the 28 real cases of Hance (sara-mind, cases 01-28): what names a case in a text and what does not.
  const TITLES: [string, string[], string[]][] = [
    [
      'Музыкальная школа МИО',
      ['Делали для школы МИО.', 'Как у МИО, там вели соцсети.'],
      ['У вас заказ для музыкальной школы?', 'Для музыкальной школы это нормально.'],
    ],
    ['Грибатория', ['Делали для Грибатории.'], ['Про грибы я не знаю.']],
    ['Unchain', ['Для Unchain делали сайт.'], ['Цепочка заявок.']],
    [
      'Компания по производству мебели Arleon',
      ['Делали для Arleon.'],
      ['Компании по производству мебели часто начинают с каталога.'],
    ],
    [
      'A/B Company: аудиобрендинг для HoReCa',
      ['Делали для A/B Company.'],
      ['Запускали A/B тесты.', 'Аудиобрендинг для HoReCa делают так.'],
    ],
    ['Sotnikova Agency', ['Делали для Sotnikova.'], ['Агентство это про людей.']],
    ['SkillCode', ['Опыт в SkillCode.'], ['Skill без кода.']],
    [
      'Ресторан «Как Дома», Горловка',
      ['Делали для «Как Дома».', 'Как Дома делали сайт.'],
      ['Делаем всё как дома.', 'Ресторан в Горловке понятный кейс.'],
    ],
    ['Viv Profit', ['Делали для Viv Profit.'], ['Прибыль растёт.']],
    ['Levkorz', ['Делали для Levkorz.'], ['Корзина заказов.']],
    [
      'SkyRoom: подвесные потолки, Москва и МО',
      ['Делали для SkyRoom.'],
      ['Подвесные потолки в Москве, да.'],
    ],
    [
      'Компания из сферы строительства',
      [],
      ['Для компании из сферы строительства это типично.', 'Строительная компания, понятно.'],
    ],
    ['Парсинг базы для отдела продаж', [], ['Парсинг базы для отдела продаж нужен?']],
    ['Разработка стратегии продаж', [], ['Разработка стратегии продаж идёт первой.']],
    [
      'Частный проект / компания не зафиксирована',
      [],
      ['Частный проект, понятно.', 'Компания не зафиксирована в заказе.'],
    ],
    [
      'Стальной Каркас',
      ['Делали для «Стальной Каркас».', 'Как у Стальной Каркас.'],
      ['Стальной каркас здания считает конструктор.', 'Нужен стальной каркас, да.'],
    ],
    ['Онлайн-курс для детей', [], ['Онлайн-курс для детей часто начинают с лендинга.']],
    ['Компания под NDA', [], ['Для компании под NDA название не называем.']],
    ['NEXUM', ['Делали для NEXUM.'], ['Нексус не знаю.']],
    ['Wayforce Gym', ['Делали для Wayforce.'], ['Для gym-проектов хватает лендинга.']],
    [
      'Боулинг-клуб 7.10',
      ['Делали для боулинг-клуба 7.10.', 'Клуб 7.10, стратегия.'],
      ['Для боулинг-клуба это нормально.', 'Боулинг-клуб это про вечер.'],
    ],
    ['B2B-компания под NDA', [], ['Для B2B-компании под NDA так и делаем.']],
    [
      'Максималист: 1С:Франчайзи',
      ['Делали для Максималист.'],
      ['Франчайзи это отдельный разговор.'],
    ],
    [
      'Akopov Team / LevTrain',
      ['Делали для LevTrain.', 'Делали для Akopov.', 'Akopov Team и LevTrain.'],
      ['Команда это про людей.'],
    ],
    [
      'Оптовая торговля стройматериалами, Санкт-Петербург: NDA',
      [],
      ['Оптовая торговля стройматериалами в Санкт-Петербурге, да.'],
    ],
    ['StroiCRM', ['Делали для StroiCRM.'], ['Подключим CRM.']],
    [
      'Банкротство физических лиц, Ростов-на-Дону: NDA',
      [],
      ['Банкротство физических лиц, Ростов-на-Дону, знакомая тема.'],
    ],
    [
      'Аутсорсинг бухгалтерии, Воронеж: NDA',
      [],
      ['Аутсорсинг бухгалтерии в Воронеже, знакомая тема.'],
    ],
  ]

  it('FR-CONV-4: only a brand word of the title names a case, a descriptive title is told by its id', () => {
    for (const [title, names, notNames] of TITLES) {
      for (const text of names) expect(namesCase(text, title), `${title} | ${text}`).toBe(true)
      for (const text of notNames) expect(namesCase(text, title), `${title} | ${text}`).toBe(false)
    }
  })

  it('FR-CONV-4: a descriptive title in a text is no repeat and no second case', () => {
    const SCHOOL = caseHit({
      id: 'k-case-07',
      title: 'Музыкальная школа МИО',
      summary: 'Сделали брендинг.',
    })
    const told = [{ id: SCHOOL.id, title: SCHOOL.title }]
    // The order is about a music school: that is not the case told again.
    expect(
      withCases('Для музыкальной школы начнём с сайта.', { told, choice: choose(CEILINGS) }),
    ).not.toContain('case.repeat')
    // The id again and the brand name in the text still are.
    expect(withCases('Делали для МИО.', { told })).toContain('case.repeat')
    expect(withCases('Делали для Потолок-Арт.', { told, choice: choose(SCHOOL) })).toContain(
      'case.repeat',
    )
    // A school of dance is the client's trade, not a second case of the library.
    expect(
      withCases('Делали для Потолок-Арт, а ваша школа танцев это другой масштаб.', {
        offered: [CEILINGS, DANCE],
        choice: choose(CEILINGS),
      }),
    ).toEqual([])
    // Two branded cases in one text are two cases.
    expect(
      withCases('Делали для Потолок-Арт и для Окна-Мастер.', {
        offered: [CEILINGS, WINDOWS],
        choice: choose(CEILINGS),
      }),
    ).toEqual(['case.many'])
  })

  it('FR-CONV-4: «7.10» in the name of a chosen open case is no date, another date still is', () => {
    const BOWLING = caseHit({
      id: 'k-case-21',
      title: 'Боулинг-клуб 7.10',
      summary: 'Разработали стратегию и план роста для боулинг-клуба.',
      showRules: ['Компанию и ссылку можно называть.'],
    })
    const text = 'Делали стратегию для боулинг-клуба 7.10, внедрять они не стали.'
    expect(withCases(text, { offered: [BOWLING], choice: choose(BOWLING) })).toEqual([])
    // The same words with no case chosen: «7.10» is a date no record has.
    expect(withCases(text, { offered: [BOWLING] })).toContain('facts.numbers')
    // A closed name is not told at all, and a date beside the name is still a date.
    const other = checkReplyText(
      input({
        text: 'Делали стратегию для боулинг-клуба 7.10, созвонимся 8.10 в удобное время.',
        cases: { offered: [BOWLING], told: [], choice: choose(BOWLING) },
      }),
    )
    expect(other.filter((x) => x.id === 'facts.numbers').map((x) => x.detail)).toEqual([
      expect.stringContaining('8.10'),
    ])
  })

  it('FR-CONV-4: an offered case named in the text but not chosen has no moment', () => {
    expect(withCases('Как у Потолок-Арт, там заявки через сайт.', { offered: [CEILINGS] })).toEqual(
      ['case.no_moment'],
    )
    // Chosen, it has a moment; not named, it is not told.
    expect(
      withCases('Как у Потолок-Арт, там заявки через сайт.', {
        offered: [CEILINGS],
        choice: choose(CEILINGS),
      }),
    ).toEqual([])
    expect(withCases('Понимаю, сайт нужен к запуску.', { offered: [CEILINGS] })).toEqual([])
  })

  it('FR-CONV-4: «взгляните на наш кейс» is robotic', () => {
    for (const text of [
      'Взгляните на наш кейс!',
      'Посмотрите наше портфолио.',
      'У нас богатый опыт в таких проектах.',
      'Посмотрите наши кейсы.',
    ]) {
      expect(ids({ text }), text).toEqual(['case.ad'])
      expect(withCases(text, { offered: [CEILINGS] }), text).toContain('case.ad')
    }
  })

  it('FR-CONV-4: the model writes no link', () => {
    for (const text of [
      'Кейс тут: https://potolok-art.example/case',
      'Смотрите www.potolok-art.example',
      'Сайт potolok-art.ru, там всё видно.',
    ])
      expect(ids({ text }), text).toContain('case.link')
    expect(ids({ text: 'Сайт делаем за 2-3 недели.' })).toEqual([])
  })
})
