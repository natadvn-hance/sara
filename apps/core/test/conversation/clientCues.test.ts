import { describe, expect, it } from 'vitest'
import { clientTurnBefore, isRefusal, isThinking } from '../../src/conversation/clientCues'

describe('a client who refuses', () => {
  it('FR-CONV-12: the usual ways to say no are a refusal', () => {
    for (const text of [
      'Мы выбрали другого исполнителя',
      'Спасибо, выбрали другую студию',
      'Уже нашли исполнителя, спасибо',
      'Нашёл подрядчика, извините',
      'Нашли другого специалиста',
      'Это уже не актуально',
      'Заказ неактуален',
      'К сожалению, уже не актуально.',
      'Нам это не нужно',
      'Спасибо, не надо',
      'Нет, спасибо',
      'Мы передумали',
      'Я передумал делать сайт',
      'Отказываемся от услуг',
      'Отказываюсь, извините',
      'Мы отказались от этой идеи',
      'Не заинтересованы',
      'Нам это не интересно',
      'Это нас не интересует',
      'Закрыл заказ, спасибо',
      'Мы отменили заказ',
      'Заказали у другого, спасибо за отклик',
      'Обратились к другим специалистам',
      'НАШЛИ ИСПОЛНИТЕЛЯ!',
    ])
      expect(isRefusal(text), text).toBe(true)
  })

  it('FR-CONV-12: an ordinary thanks, a question or a later «not now» is no refusal', () => {
    for (const text of [
      'Спасибо',
      'Спасибо, посмотрю',
      'Хорошо, жду',
      'Ок',
      'Сколько это будет стоить?',
      'Пока не актуально, вернёмся к этому в январе',
      'Не нужно звонить, давайте в переписке',
      'Не надо торопиться, подумаем',
      'Давайте обсудим с вами сроки',
      'Нашли ваш отклик, интересно',
      'Не нужно ли что-то подготовить?',
      '',
    ])
      expect(isRefusal(text), text).toBe(false)
  })
})

describe('a client who goes to think', () => {
  it('FR-CONV-12: «я подумаю» and its kin are thinking', () => {
    for (const text of [
      'Я подумаю',
      'Спасибо, подумаем',
      'Надо подумать',
      'Нужно подумать над этим',
      'Посоветуюсь и напишу',
      'Обсудим с коллегами и вернёмся',
      'Обсудим это с мужем',
      'Обсудим внутри команды',
      'Вернусь к вам на следующей неделе',
      'Вернёмся к вам позже',
      'Дам знать',
      'Мне надо всё обдумать',
    ])
      expect(isThinking(text), text).toBe(true)
  })

  it('FR-CONV-12: a plain thanks, a talk with us or with Boris is not thinking', () => {
    for (const text of [
      'Спасибо',
      'Давайте обсудим с вами детали',
      'Хочу обсудить с Борисом',
      'Подумайте, пожалуйста, как лучше',
      'Сколько стоит?',
      '',
    ])
      expect(isThinking(text), text).toBe(false)
  })
})

describe('the client turn before our message', () => {
  const m = (id: string, side: string, text: string) => ({ id, side, text })

  it('FR-CONV-12: it is the client messages right before our last message, and nothing else', () => {
    const chat = [
      m('1', 'specialist', 'Добрый день, отклик'),
      m('2', 'client', 'Сколько стоит?'),
      m('3', 'specialist', 'Это к Борису'),
      m('4', 'client', 'Спасибо'),
      m('5', 'client', 'мы выбрали другого'),
      m('6', 'specialist', 'Понимаю, всего доброго'),
    ]
    expect(clientTurnBefore(chat, '6')).toBe('Спасибо\nмы выбрали другого')
    expect(clientTurnBefore(chat, '3')).toBe('Сколько стоит?')
    // Our message after our message, a bid first: no client turn.
    expect(clientTurnBefore(chat, '1')).toBe('')
    expect(clientTurnBefore([...chat, m('7', 'specialist', 'И ещё')], '7')).toBe('')
    expect(clientTurnBefore(chat, 'nope')).toBe('')
  })

  it('FR-CONV-12: a system message between the client and us is passed over', () => {
    const chat = [
      m('1', 'client', 'Нашли исполнителя'),
      m('2', 'system', 'Заказ закрыт'),
      m('3', 'specialist', 'Понимаю'),
    ]
    expect(clientTurnBefore(chat, '3')).toBe('Нашли исполнителя')
  })
})
