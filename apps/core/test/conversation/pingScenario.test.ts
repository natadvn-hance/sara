import { describe, expect, it } from 'vitest'
import {
  awaitedItem,
  type ChatLine,
  morningAfter,
  movedToMessenger,
  namedDay,
  ourPromise,
  pingScenario,
  pingWaits,
} from '../../src/conversation/pingScenario'

// Wednesday 04.11.2026, 12:00 Moscow.
const WED = new Date('2026-11-04T09:00:00Z')
const MON = new Date('2026-11-09T09:00:00Z')
const DAY = 24 * 3600_000

let n = 0
const line = (side: string, text: string, at = WED.toISOString()): ChatLine => ({
  id: `m-${++n}`,
  side,
  text,
  at,
})

describe('a day the client named (spec 2026-11-07-organic-pings)', () => {
  it('reads the days a client names for his own next move', () => {
    const cases: [string, string][] = [
      ['Посмотрю и напишу в понедельник', '2026-11-09'],
      ['Завтра отпишусь', '2026-11-05'],
      ['Послезавтра скину', '2026-11-06'],
      ['Через неделю пришлю ТЗ', '2026-11-11'],
      ['Через 3 дня вернусь к вам', '2026-11-07'],
      ['Через пару недель обсудим', '2026-11-18'],
      ['Отпишусь после 15-го', '2026-11-15'],
      ['Вернусь к вам 20 ноября', '2026-11-20'],
      ['Пришлю 10.11', '2026-11-10'],
      ['На следующей неделе напишу', '2026-11-11'],
      ['В конце недели дам знать', '2026-11-06'],
      ['Решим к пятнице', '2026-11-06'],
    ]
    for (const [text, day] of cases) expect(namedDay(text, WED)?.day, text).toBe(day)
  })

  it('a weekday said on that weekday is the one a week later; a past date is next year', () => {
    expect(namedDay('Напишу в понедельник', MON)?.day).toBe('2026-11-16')
    expect(namedDay('Вернусь к вам 10 января', WED)?.day).toBe('2027-01-10')
  })

  it('a date of the work itself is no day of the client’s answer', () => {
    expect(namedDay('Сайт нужен к 15 декабря', WED)).toBeNull()
    expect(namedDay('Бюджет до 15 тысяч, запуск в понедельник', WED)).toBeNull()
    expect(namedDay('Спасибо, подумаю', WED)).toBeNull()
  })

  it('the last sentence with a day wins and is quoted', () => {
    expect(namedDay('Завтра не смогу. Посмотрю и в пятницу напишу.', WED)).toEqual({
      day: '2026-11-06',
      quote: 'Посмотрю и в пятницу напишу.',
    })
  })
})

describe('what we wait for, what we promised', () => {
  it('our request names the thing we wait for', () => {
    expect(awaitedItem('Пришлите, пожалуйста, ТЗ, посмотрю и оценю', '')?.item).toBe('tz')
    expect(awaitedItem('Какой бюджет закладываете на запуск?', '')?.item).toBe('budget')
    expect(awaitedItem('Когда вам удобно созвониться?', '')?.item).toBe('call_time')
    expect(awaitedItem('Можете скинуть доступы к рекламному кабинету?', '')?.item).toBe('materials')
  })

  it('so does the client’s own promise to send it', () => {
    expect(awaitedItem('Хорошо, жду', 'Скину фото завтра')?.item).toBe('materials')
    expect(awaitedItem('Хорошо, жду', 'Уточню бюджет у директора')?.item).toBe('budget')
    expect(awaitedItem('Спасибо!', 'Хорошо')).toBeNull()
  })

  it('a promise of ours that asks nothing of the client is ours to keep', () => {
    expect(ourPromise('Понял. Подготовлю предложение и пришлю завтра.')).toBe(
      'Подготовлю предложение и пришлю завтра.',
    )
    expect(ourPromise('Изучу ваш сайт и вернусь с идеями')).toBe(
      'Изучу ваш сайт и вернусь с идеями',
    )
    // Asking for the ТЗ first: the next move is the client's.
    expect(ourPromise('Пришлите ТЗ, я изучу и оценю')).toBeNull()
    expect(ourPromise('Посмотрю. А какой у вас бюджет?')).toBeNull()
  })
})

describe('the client went to a messenger', () => {
  const offer = line('specialist', 'Если удобнее, можем продолжить в тг @bmnoian')

  it('our offer and his yes, his handle or «написал» move him', () => {
    expect(movedToMessenger([offer, line('client', 'Да, написал вам')], '@bmnoian')).toBe(
      'Да, написал вам',
    )
    expect(movedToMessenger([offer, line('client', 'Давайте')], '@bmnoian')).toBe('Давайте')
    expect(movedToMessenger([offer, line('client', 'Мой ник @ivan_petrov')], '@bmnoian')).toBe(
      'Мой ник @ivan_petrov',
    )
  })

  it('he himself asks to talk in a messenger', () => {
    expect(
      movedToMessenger([line('client', 'Пишите мне в телеграм, так быстрее')], '@bmnoian'),
    ).toBe('Пишите мне в телеграм, так быстрее')
  })

  it('a no, a yes to the call instead, or silence keep him on Profi.ru', () => {
    expect(movedToMessenger([offer, line('client', 'Нет, лучше здесь')], '@bmnoian')).toBeNull()
    expect(movedToMessenger([offer], '@bmnoian')).toBeNull()
    const both = line('specialist', 'Удобно созвониться или списаться в тг @bmnoian?')
    expect(movedToMessenger([both, line('client', 'Давайте созвонимся')], '@bmnoian')).toBeNull()
    expect(movedToMessenger([both, line('client', 'Да')], '@bmnoian')).toBeNull()
  })
})

describe('the scenario of a silence', () => {
  const bid = () => line('specialist', 'Анна, добрый день! Сделаем сайт для клиники.')
  const scene = (
    lines: ChatLine[],
    meeting: Parameters<typeof pingScenario>[0]['meeting'] = null,
  ) => pingScenario({ lines, anchorId: lines.at(-1)?.id ?? '', meeting, handle: '@bmnoian' })

  it('silent since the bid: the client never wrote', () => {
    expect(scene([bid(), line('specialist', 'Какой у вас бюджет?')])).toMatchObject({
      kind: 'since_bid',
      item: 'budget',
    })
  })

  it('mid-conversation, thinking, awaiting, a named day and our promise', () => {
    const talk = (client: string, ours: string) =>
      scene([bid(), line('client', client), line('specialist', ours)])
    expect(talk('А сроки?', 'Около месяца, зависит от объема.').kind).toBe('mid')
    expect(talk('Спасибо, я подумаю', 'Конечно, без спешки.').kind).toBe('thinking')
    expect(talk('Интересно', 'Пришлите ТЗ, посмотрю и оценю.')).toMatchObject({
      kind: 'awaiting',
      item: 'tz',
      quote: 'Пришлите ТЗ, посмотрю и оценю.',
    })
    expect(talk('Пришлю ТЗ в среду', 'Отлично, жду.')).toMatchObject({
      kind: 'named_date',
      day: '2026-11-11',
      item: 'tz',
    })
    expect(talk('Хотим понять, с чего начать', 'Изучу ваш сайт и вернусь с идеями.')).toMatchObject(
      { kind: 'our_promise', quote: 'Изучу ваш сайт и вернусь с идеями.' },
    )
  })

  it('a held call follows its next step; a messenger comes before everything', () => {
    const lines = [bid(), line('client', 'Давайте созвонимся'), line('specialist', 'Отлично!')]
    expect(scene(lines, { nextStep: 'клиент пришлет бриф', nextStepOn: '2026-11-10' })).toEqual({
      kind: 'after_meeting',
      quote: null,
      item: null,
      day: '2026-11-10',
      nextStep: 'клиент пришлет бриф',
    })
    const moved = [
      bid(),
      line('client', 'Пишите в телеграм'),
      line('specialist', 'Хорошо, напишу там'),
    ]
    expect(scene(moved, { nextStep: null, nextStepOn: null }).kind).toBe('messenger')
  })

  it('the waits: a named day waits for the morning after it, a stranger is pressed less often', () => {
    const named = pingWaits({
      kind: 'named_date',
      quote: null,
      item: null,
      day: '2026-11-09',
      nextStep: null,
    })
    expect(named.notBefore?.toISOString()).toBe('2026-11-10T07:00:00.000Z')
    expect(morningAfter('2026-11-09').toISOString()).toBe('2026-11-10T07:00:00.000Z')
    const stranger = pingWaits({
      kind: 'since_bid',
      quote: null,
      item: null,
      day: null,
      nextStep: null,
    })
    expect(stranger).toEqual({ first: DAY, second: 3 * DAY, third: 4 * DAY, notBefore: null })
    const mid = pingWaits({ kind: 'mid', quote: null, item: null, day: null, nextStep: null })
    expect([mid.first, mid.second, mid.third]).toEqual([DAY, 2 * DAY, 3 * DAY])
  })
})
