import { describe, expect, it } from 'vitest'
import { neuroSpeech, neuroSpeechReason } from '../../src/text/neuroSpeech'

describe('FR-CONV-15: the «не X, а Y» turn is found', () => {
  it('finds the words of Boris and their kin', () => {
    for (const text of [
      'Вам нужен не подрядчик на разовые задачи, а человек, который берет это на себя.',
      'Задача не просто провести встречи, а понять, что у вас происходит.',
      'Главная беда не в качестве работы, а в том, что нет системы.',
      'Это не только сайт, но и воронка.',
      'Важна не цена, а результат.',
      'Нужно не звонить, а писать.',
      'Магазин должен получать покупателей, а не просто клики.',
    ])
      expect(neuroSpeech(text), text).not.toBeNull()
  })

  it('FR-CONV-15: finds the chatbot stamps, and not the words Boris uses himself', () => {
    for (const text of [
      'Давайте разберемся, что вам нужно.',
      'Важно отметить, что сроки зависят от задачи.',
      'Отличный вопрос! Сейчас отвечу.',
      'Надеюсь, это поможет.',
      'Дайте знать, если нужны детали.',
      'На самом деле вопрос глубже.',
      'Без шаблонов. Без воды. Только результат.',
      'Подводя итог, начнем с анализа.',
    ])
      expect(neuroSpeech(text), text).not.toBeNull()
    for (const text of [
      'Важно понимать, есть ли у вас отдел продаж.',
      'Вижу широкий спектр услуг, и блоки уникальные.',
      'Давайте созвонимся и разберем задачу на встрече.',
      'Честно скажу: химию не преподаю.',
    ])
      expect(neuroSpeech(text), text).toBeNull()
  })

  it('leaves plain talk alone', () => {
    for (const text of [
      'Давайте не во вторник, а в среду.',
      'Не в 10, а в 11 удобно?',
      'Не получится завтра, а в пятницу смогу.',
      'Я не против, а вы?',
      'Работаем без предоплаты, а оплата по этапам.',
      'Не знаю, а что вы хотели бы?',
    ])
      expect(neuroSpeech(text), text).toBeNull()
  })
})

describe('FR-CONV-15: an opening frame with a colon is found (Boris, 11.11.2026)', () => {
  it('finds a frame that announces what comes, at the start of a text or of a sentence', () => {
    for (const text of [
      'Хочу уточнить одну вещь по брендбуку: цвета оставляем прежние?',
      'По опыту: такие сайты делаются за две недели',
      'Хочу предупредить: сроки зависят от материалов',
      'Понял задачу. Сразу предупрежу: без текстов сайт не запустить',
      'Спасибо за ответ!\nИтого: начинаем с анализа',
      'Хотел бы уточнить: вам удобнее созвон или переписка?',
      'Если коротко: нужен лендинг и реклама',
      'Есть предложение: начнем с аудита',
    ])
      expect(neuroSpeech(text)?.kind, text).toBe('рамка')
  })

  it('leaves a colon inside a living phrase, his own «А давайте так:» and «Возник вопрос:», prices and times', () => {
    for (const text of [
      'А давайте так: если берем тильду, первый год оплачиваем мы',
      'Возник вопрос: а основной поток идет из блогов?',
      'Нужно две вещи: сайт и понятная заявка',
      'Стоимость: 35 000, сроки: две недели',
      'Удобно завтра в 16:00?',
      'Например: школа танцев в Краснодаре',
    ])
      expect(neuroSpeech(text), text).toBeNull()
  })

  it('tells the rewrite what the frame is and how to say it', () => {
    const hit = neuroSpeech('Хочу уточнить одну вещь по брендбуку: цвета оставляем?')
    expect(hit?.quote).toBe('хочу уточнить одну вещь по брендбуку:')
    expect(neuroSpeechReason(hit as NonNullable<typeof hit>)).toMatch(/рамк[^\n]*двоеточ/)
  })
})
