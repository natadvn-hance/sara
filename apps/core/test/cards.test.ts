import { describe, expect, it } from 'vitest'
import {
  analysisMessages,
  type LeadCard,
  leadCardKeyboard,
  leadCardText,
  plainFallback,
  renderLeadCard,
  TEXTS,
  telegramTextLength,
} from '../src/notify/cards'

const READING = {
  said: 'Сайт клиники: услуги, врачи, онлайн-запись',
  layers: 'Сама назвала, что нужно; хочет готовый результат',
  wants: 'Начать запись онлайн без долгого запуска',
  who: 'Владелец небольшой клиники',
  risks: 'Сроки не названы',
  job: 'Чтобы запись шла сама',
}
const ANALYSIS = {
  hiddenNeed: 'Боится долгого запуска',
  risk: 'Объём больше, чем звучит',
  condition: 'Брать, если сроки понятны',
  reading: READING,
}
const DRAFT = { text: 'Ирина, добрый день!\n\nПонимаю задачу.', priceRub: 90000 }
const CLIENT = {
  name: 'Ирина',
  on_profi_since: 'На Профи.ру с 7 сентября 2020',
  phone_verified: true,
  reviews: { positive: 3, negative: 1 },
  review_tags: ['Перестала отвечать', 'Торговалась', 'Вежливая', 'Четвёртый тег'],
}
const card: LeadCard = {
  taskId: '0192f3c4-5b6a-7c8d-9e0f-112233445566',
  orderId: '90001',
  title: 'Сайт для клиники',
  city: 'Краснодар',
  budgetText: 'до 150 000 ₽',
  clientName: 'Ирина',
  text: 'Нужен сайт для клиники.\nУслуги, врачи, запись.',
  verdict: 'fit',
  reason: 'Нужен сайт',
  bidPriceRub: 210,
}
const DASH = String.fromCharCode(0x2014)
const NBSP = '\u00a0'
const LINK = '<a href="https://profi.ru/backoffice/n.php?o=90001">Открыть заявку на Профи.ру</a>'
const full: LeadCard = {
  ...card,
  score: { value: 68, version: 1, reason: 'Зрелый бизнес, понятная задача' },
  draft: DRAFT,
  analysis: ANALYSIS,
  clientInfo: CLIENT,
}

describe('the lead card layout', () => {
  it('FR-LEAD-7: the whole card in order: head, client, order text, score, разбор, draft, link', () => {
    expect(leadCardText(full).split('\n')).toEqual([
      '<b>🔔 Сайт для клиники</b>',
      `Краснодар · бюджет до 150 000 ₽ · отклик 210${NBSP}₽`,
      '',
      '<b>Клиент:</b> Ирина',
      'На Профи.ру с 7 сентября 2020 · номер подтверждён',
      'Отзывы: +3 / −1 · «Перестала отвечать», «Торговалась», «Вежливая»',
      '',
      '<b>Заявка</b>',
      '<blockquote expandable>Нужен сайт для клиники.',
      'Услуги, врачи, запись.</blockquote>',
      '',
      '<b>Балл 68</b> (правила v1). Зрелый бизнес, понятная задача',
      '<b>Разбор:</b> Боится долгого запуска',
      '<b>Риск:</b> Объём больше, чем звучит. <b>Условие:</b> Брать, если сроки понятны',
      '',
      '<b>Черновик отклика</b>',
      '<blockquote>Ирина, добрый день!',
      '',
      'Понимаю задачу.</blockquote>',
      `Стоимость услуги: 90${NBSP}000${NBSP}₽`,
      '',
      LINK,
    ])
  })

  it("FR-LEAD-1: a raised-again order has one more line under the head, with the site's words", () => {
    const lines = leadCardText({
      ...card,
      reposted: { notice: 'Клиент запросил ещё отклики 4\u00a0дня\u00a0назад <срочно>' },
    }).split('\n')
    expect(lines.slice(0, 4)).toEqual([
      '<b>🔔 Сайт для клиники</b>',
      `Краснодар · бюджет до 150 000 ₽ · отклик 210${NBSP}₽`,
      'Заказ поднят повторно: Клиент запросил ещё отклики 4 дня назад &lt;срочно&gt;',
      '',
    ])
    expect(leadCardText({ ...card, reposted: { notice: null } }).split('\n')[2]).toBe(
      'Заказ поднят повторно',
    )
    expect(leadCardText({ ...card, reposted: null })).not.toContain('поднят')
    expect(leadCardText(card)).not.toContain('поднят')
  })

  it('FR-LEAD-7: the head says what the client budget and the bid fee are when they are unknown', () => {
    const lines = leadCardText({ ...card, budgetText: null, bidPriceRub: 0 }).split('\n')
    expect(lines[1]).toBe('Краснодар · бюджет не указан · цена отклика пока неизвестна')
  })

  it('FR-LEAD-7: the client block without client info is the name alone', () => {
    const text = leadCardText({ ...card, clientInfo: null })
    expect(text).toContain('<b>Клиент:</b> Ирина\n\n<b>Заявка</b>')
    expect(text).not.toContain('Отзывы')
    expect(text).not.toContain('На Профи.ру с')
  })

  it('FR-LEAD-7: client info with parts missing shows only the parts the site gave', () => {
    const info = {
      name: null,
      on_profi_since: null,
      phone_verified: false,
      reviews: null,
      review_tags: [],
    }
    const text = leadCardText({ ...card, clientInfo: info })
    expect(text).toContain('<b>Клиент:</b> Ирина\n\n<b>Заявка</b>')
    const some = leadCardText({
      ...card,
      clientInfo: { ...info, reviews: { positive: 0, negative: 2 }, review_tags: ['Грубил'] },
    })
    expect(some).toContain('<b>Клиент:</b> Ирина\nОтзывы: +0 / −2 · «Грубил»\n\n<b>Заявка</b>')
  })

  it('FR-LEAD-7: the since text is as the site writes it, or gets its beginning', () => {
    const since = (s: string) =>
      leadCardText({ ...card, clientInfo: { ...CLIENT, on_profi_since: s, phone_verified: null } })
    expect(since('На Профи.ру с 7 сентября 2020')).toContain('\nНа Профи.ру с 7 сентября 2020\n')
    expect(since('7 сентября 2020')).toContain('\nНа Профи.ру с 7 сентября 2020\n')
  })

  it('FR-LEAD-7: the client name on the card comes from client info when the list gave none', () => {
    const text = leadCardText({ ...card, clientName: '', clientInfo: { ...CLIENT, name: 'Анна' } })
    expect(text).toContain('<b>Клиент:</b> Анна')
    expect(leadCardText({ ...card, clientName: '' })).toContain('<b>Клиент:</b> имя не указано')
  })

  it('FR-LEAD-7: the name from the order page wins over the one from the list: it is the fuller one', () => {
    const text = leadCardText({
      ...card,
      clientName: 'Ира',
      clientInfo: { ...CLIENT, name: 'Ирина Петрова' },
    })
    expect(text).toContain('<b>Клиент:</b> Ирина Петрова')
    expect(text).not.toContain('<b>Клиент:</b> Ира\n')
    const blank = leadCardText({
      ...card,
      clientName: 'Ира',
      clientInfo: { ...CLIENT, name: '  ' },
    })
    expect(blank).toContain('<b>Клиент:</b> Ира\n')
  })

  it('FR-LEAD-7: a reminder is the same card with a line that it waits', () => {
    const lines = leadCardText({ ...full, reminder: true }).split('\n')
    expect(lines.slice(0, 3)).toEqual([
      '<b>⏰ Сайт для клиники</b>',
      '<i>Заявка ждёт решения</i>',
      `Краснодар · бюджет до 150 000 ₽ · отклик 210${NBSP}₽`,
    ])
    expect(lines.at(-1)).toBe(LINK)
  })

  it('FR-LEAD-7: a card of an old lead, without reading, client info or draft, is shorter and not an error', () => {
    const text = leadCardText(card)
    expect(text.split('\n')).toEqual([
      '<b>🔔 Сайт для клиники</b>',
      `Краснодар · бюджет до 150 000 ₽ · отклик 210${NBSP}₽`,
      '',
      '<b>Клиент:</b> Ирина',
      '',
      '<b>Заявка</b>',
      '<blockquote expandable>Нужен сайт для клиники.',
      'Услуги, врачи, запись.</blockquote>',
      '',
      'Подходит: Нужен сайт',
      '',
      'Черновика нет: Аналитик не ответил. Нажми «Изменить» и пришли текст, а цену услуги отдельной строкой, например «цена 5000».',
      '',
      LINK,
    ])
  })

  it('FR-LEAD-7: the verdict and the missing score keep their words', () => {
    const maybe = leadCardText({ ...card, verdict: 'maybe', reason: 'Пограничная' })
    expect(maybe).toContain('Возможно: Пограничная')
    const none = leadCardText({ ...card, verdict: null, reason: null, unscored: true })
    expect(none).toContain('Сортировщик не ответил, проверь сам')
    expect(none).toContain('Без оценки: Оценщик не ответил')
  })

  it('FR-LEAD-6: a draft without a price says the bid needs one and how to give it', () => {
    const text = leadCardText({ ...card, draft: { ...DRAFT, priceRub: null } })
    expect(text).toContain(
      '</blockquote>\nСтоимость услуги: не указана. Без неё Профи.ру отклик не примет: пришли её через «Изменить» отдельной строкой, например «цена 5000».\n',
    )
  })

  it('FR-LEAD-6: a card without a draft says how to add one, and the price', () => {
    for (const draft of [null, undefined])
      expect(leadCardText({ ...card, draft })).toContain(
        'Черновика нет: Аналитик не ответил. Нажми «Изменить» и пришли текст, а цену услуги отдельной строкой, например «цена 5000».',
      )
  })

  it('FR-LEAD-7: the order text is empty on a card of a lead without one: the block says so', () => {
    expect(leadCardText({ ...card, text: '  ' })).toContain(
      '<b>Заявка</b>\n<blockquote expandable>Текста заявки нет.</blockquote>',
    )
  })
})

describe('the lead card odd values', () => {
  it('FR-LEAD-7: an empty part of the short разбор is left out, not shown as a broken line', () => {
    const lines = (a: Partial<typeof ANALYSIS>) =>
      leadCardText({ ...card, analysis: { ...ANALYSIS, ...a } }).split('\n')
    expect(lines({ hiddenNeed: ' ', risk: '' })).toContain(
      '<b>Условие:</b> Брать, если сроки понятны',
    )
    expect(lines({ hiddenNeed: ' ', risk: '' }).join('\n')).not.toContain('<b>Разбор:</b>')
    expect(lines({ hiddenNeed: ' ', risk: '' }).join('\n')).not.toContain('<b>Риск:</b>')
    expect(lines({ condition: '' })).toContain('<b>Риск:</b> Объём больше, чем звучит.')
    const none = lines({ hiddenNeed: '', risk: '', condition: ' ' }).join('\n')
    expect(none).not.toMatch(/Разбор:|Риск:|Условие:/)
  })

  it('FR-LEAD-7: a since text that already starts with «с» does not get a second one', () => {
    const since = (t: string) =>
      leadCardText({ ...card, clientInfo: { ...CLIENT, on_profi_since: t, phone_verified: null } })
    expect(since('с 7 сентября 2020')).toContain('\nНа Профи.ру с 7 сентября 2020\n')
    expect(since('С 7 сентября 2020')).toContain('\nНа Профи.ру с 7 сентября 2020\n')
  })
})

describe('the plain text fallback', () => {
  it('FR-LEAD-7: a card at the limit still fits 4096 as plain text and keeps the written-out link', () => {
    const r = renderLeadCard({ ...full, text: 'a '.repeat(9000) })
    expect(telegramTextLength(r.html)).toBeGreaterThan(3900)
    const plain = plainFallback(r.html)
    expect(plain.length).toBeLessThanOrEqual(4096)
    expect(plain.endsWith('https://profi.ru/backoffice/n.php?o=90001')).toBe(true)
    expect(plain).not.toMatch(/<\/?[a-z]/)
    expect(plain).toContain('Стоимость услуги')
  })

  it('FR-LEAD-7: a short card is just its text without markup, entities decoded, the link written out', () => {
    const plain = plainFallback(leadCardText({ ...card, text: 'a < b & c' }))
    expect(plain).toContain('a < b & c')
    expect(plain.split('\n').at(-1)).toBe(
      'Открыть заявку на Профи.ру: https://profi.ru/backoffice/n.php?o=90001',
    )
  })
})

describe('the lead card escaping', () => {
  const evil = '<b>жирно</b> & <script>alert(1)</script> "кавычки" a<b'
  const escaped =
    '&lt;b&gt;жирно&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt; "кавычки" a&lt;b'

  it('FR-LEAD-7: every value from the site or the model is escaped, nothing becomes a tag', () => {
    const text = leadCardText({
      ...full,
      title: evil,
      city: evil,
      budgetText: evil,
      clientName: evil,
      text: evil,
      reason: evil,
      score: { value: 68, version: 1, reason: evil },
      draft: { text: evil, priceRub: null },
      analysis: { ...ANALYSIS, hiddenNeed: evil, risk: evil, condition: evil },
      clientInfo: { ...CLIENT, name: evil, on_profi_since: evil, review_tags: [evil, evil, evil] },
    })
    expect(text).not.toContain('<script>')
    expect(text).not.toContain('<b>жирно')
    expect(text).toContain(`<b>🔔 ${escaped}</b>`)
    expect(text).toContain(`<blockquote expandable>${escaped}</blockquote>`)
    expect(text).toContain(`<blockquote>${escaped}</blockquote>`)
    expect(text).toContain(`<b>Клиент:</b> ${escaped}`)
    // Only the tags the card itself writes are left.
    const tags = [...text.matchAll(/<\/?([a-z]+)[^>]*>/g)].map((m) => m[1])
    expect(new Set(tags)).toEqual(new Set(['b', 'a', 'blockquote']))
  })

  it('FR-LEAD-7: the name from the list is escaped when the order page gave none', () => {
    expect(leadCardText({ ...card, clientName: evil })).toContain(`<b>Клиент:</b> ${escaped}`)
  })

  it('FR-LEAD-7: the verdict line of a card without a score is escaped too', () => {
    const text = leadCardText({ ...card, reason: evil })
    expect(text).toContain(`Подходит: ${escaped}`)
  })

  it('FR-LEAD-7: an order id that is not plain is escaped in the link', () => {
    const text = leadCardText({ ...card, orderId: '9"><b>1' })
    expect(text).not.toContain('"><b>')
  })

  it('NFR-UX-1: telegramTextLength counts what Telegram counts: the text without tags, entities as one character', () => {
    expect(telegramTextLength('<b>a&amp;b</b> &lt;&gt;')).toBe(6)
    expect(telegramTextLength('<a href="https://x.ru/?a=1&amp;b=2">ссылка</a>')).toBe(6)
  })
})

describe('the lead card length', () => {
  const long = (n: number) => `${'Очень длинная заявка. '.repeat(Math.ceil(n / 22))}`.slice(0, n)

  it('FR-LEAD-7: a card within 4096 characters keeps the whole order text', () => {
    const r = renderLeadCard({ ...full, text: long(1500) })
    expect(r.textCut).toBe(false)
    expect(r.html).toContain(long(1500))
  })

  it('FR-LEAD-7: a longer card shortens the order text with «…» and stays within 4096 characters', () => {
    const r = renderLeadCard({ ...full, text: long(9000) })
    expect(r.textCut).toBe(true)
    expect(telegramTextLength(r.html)).toBeLessThanOrEqual(4096)
    expect(telegramTextLength(r.html)).toBeGreaterThan(3900)
    expect(r.html).toMatch(/…<\/blockquote>/)
    // Everything after the order text is still on the card.
    expect(r.html).toContain('<b>Балл 68</b>')
    expect(r.html).toContain('Стоимость услуги')
    expect(r.html.endsWith(LINK)).toBe(true)
  })

  it('FR-LEAD-7: the cut counts entities as Telegram does and never splits one', () => {
    const r = renderLeadCard({ ...full, text: '<&>'.repeat(4000) })
    expect(r.textCut).toBe(true)
    expect(telegramTextLength(r.html)).toBeLessThanOrEqual(4096)
    // No broken entity: every ampersand starts a whole one.
    expect(r.html.match(/&(?!amp;|lt;|gt;|quot;)/g)).toBeNull()
  })

  it('FR-LEAD-7: the cut never splits an emoji', () => {
    const r = renderLeadCard({ ...full, text: '😀'.repeat(5000) })
    expect(r.textCut).toBe(true)
    expect(telegramTextLength(r.html)).toBeLessThanOrEqual(4096)
    expect(r.html).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(r.html).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })

  it('FR-LEAD-7: values of the model and the site that are too long are shortened so the card still fits', () => {
    const huge = 'Я'.repeat(3000)
    const r = renderLeadCard({
      ...full,
      title: huge,
      city: huge,
      budgetText: huge,
      clientName: huge,
      text: long(9000),
      reason: huge,
      score: { value: 68, version: 1, reason: huge },
      draft: { text: huge, priceRub: 1 },
      analysis: { ...ANALYSIS, hiddenNeed: huge, risk: huge, condition: huge },
      clientInfo: { ...CLIENT, on_profi_since: huge, review_tags: [huge, huge, huge] },
    })
    expect(telegramTextLength(r.html)).toBeLessThanOrEqual(4096)
    expect(r.html.endsWith(LINK)).toBe(true)
  })
})

describe('the lead card buttons', () => {
  it('FR-LEAD-7: the buttons are «Откликнуться за N ₽», «Разбор», «Изменить», «Пропустить»', () => {
    expect(leadCardKeyboard(card).inline_keyboard).toEqual([
      [{ text: `Откликнуться за 210${NBSP}₽`, callback_data: `t:${card.taskId}:bid` }],
      [
        { text: 'Разбор', callback_data: `t:${card.taskId}:razbor` },
        { text: 'Изменить', callback_data: `t:${card.taskId}:edit` },
        { text: 'Пропустить', callback_data: `t:${card.taskId}:skip` },
      ],
    ])
  })

  it('FR-LEAD-7: an unknown fee is not put into the bid button', () => {
    expect(leadCardKeyboard({ ...card, bidPriceRub: 0 }).inline_keyboard[0]?.[0]?.text).toBe(
      'Откликнуться',
    )
  })

  it('FR-NOTIF-1: the callback data fits Telegram: at most 64 bytes', () => {
    for (const b of leadCardKeyboard(card).inline_keyboard.flat())
      expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(64)
  })
})

describe('the «Разбор» message', () => {
  it('FR-LEAD-7: the full reading, laid out: said, layers, wants, who, risks, job, condition', () => {
    const [msg, ...rest] = analysisMessages(full)
    expect(rest).toEqual([])
    expect(msg?.split('\n')).toEqual([
      '<b>Разбор: Сайт для клиники</b>',
      '',
      '<b>Что говорит клиент</b>',
      'Сайт клиники: услуги, врачи, онлайн-запись',
      '',
      '<b>Что за этим стоит</b>',
      'Сама назвала, что нужно; хочет готовый результат',
      '',
      '<b>Чего хочет на самом деле</b>',
      'Начать запись онлайн без долгого запуска',
      '',
      '<b>Кто это</b>',
      'Владелец небольшой клиники',
      '',
      '<b>Риски</b>',
      'Сроки не названы',
      '',
      '<b>Какую задачу решает для клиента</b>',
      'Чтобы запись шла сама',
      '',
      '<b>Условие</b>',
      'Брать, если сроки понятны',
      '',
      LINK,
    ])
  })

  it('FR-LEAD-7: the order text is in the message only when the card had to cut it', () => {
    expect(analysisMessages(full).join('\n')).not.toContain('Полный текст заявки')
    const text = `Начало заявки. ${'Подробности. '.repeat(500)}Конец заявки.`
    const msgs = analysisMessages({ ...full, text })
    expect(msgs.length).toBeGreaterThan(1)
    const joined = msgs.join('\n')
    expect(joined).toContain('<b>Полный текст заявки</b>')
    expect(joined).toContain('Начало заявки.')
    expect(joined).toContain('Конец заявки.')
    expect(joined).toContain('<blockquote expandable>')
    // The link stays at the end of the last message.
    expect(msgs.at(-1)?.endsWith(LINK)).toBe(true)
    for (const m of msgs) expect(telegramTextLength(m)).toBeLessThanOrEqual(4096)
  })

  it('FR-LEAD-7: the whole text comes back whole, in pieces, with nothing lost or doubled', () => {
    const text = Array.from({ length: 900 }, (_, i) => `слово${i} <&>`).join(' ')
    const msgs = analysisMessages({ ...full, text })
    const decode = (h: string) =>
      h.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    const quoted = msgs
      .flatMap((m) => [...m.matchAll(/<blockquote expandable>([\s\S]*?)<\/blockquote>/g)])
      .map((m) => decode(m[1] ?? ''))
    expect(quoted.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
    for (const m of msgs) expect(telegramTextLength(m)).toBeLessThanOrEqual(4096)
  })

  it('FR-LEAD-7: a long order text comes whole even when the card did not cut it today: the card may have been cut before an edit', () => {
    const text = 'Подробности заявки. '.repeat(140)
    expect(renderLeadCard({ ...full, text }).textCut).toBe(false)
    const msgs = analysisMessages({ ...full, text })
    expect(msgs.join('\n')).toContain('<b>Полный текст заявки</b>')
    expect(msgs.join('\n')).toContain(text.trim())
  })

  it('FR-LEAD-7: an enormous order text is capped at a few messages and says it is cut', () => {
    const msgs = analysisMessages({ ...full, text: 'слово '.repeat(50000) })
    expect(msgs.length).toBeLessThanOrEqual(6)
    for (const m of msgs) expect(telegramTextLength(m)).toBeLessThanOrEqual(4096)
    expect(msgs.join('\n')).toContain('…</blockquote>')
    expect(msgs.at(-1)?.endsWith(LINK)).toBe(true)
  })

  it('FR-LEAD-7: a stored reading that lost its full part still gives the three short lines', () => {
    const [msg] = analysisMessages({ ...full, analysis: { ...ANALYSIS, reading: null } })
    expect(msg).toContain('Боится долгого запуска')
    expect(msg).toContain('Объём больше, чем звучит')
    expect(msg).toContain('Брать, если сроки понятны')
    expect(msg).not.toContain('Разбора для этой заявки нет')
  })

  it('FR-LEAD-7: the reading is escaped', () => {
    const msg = analysisMessages({
      ...full,
      title: 'A & B <i>',
      analysis: { ...ANALYSIS, reading: { ...READING, said: '<b>x</b> & y' } },
    }).join('')
    expect(msg).toContain('<b>Разбор: A &amp; B &lt;i&gt;</b>')
    expect(msg).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y')
  })

  it('FR-LEAD-7: without a reading it says so and still gives the whole order text', () => {
    const [msg, ...rest] = analysisMessages({ ...card, clientInfo: CLIENT })
    expect(rest).toEqual([])
    expect(msg?.split('\n')).toEqual([
      '<b>Разбор: Сайт для клиники</b>',
      '',
      'Разбора для этой заявки нет: Аналитик не ответил или заявка пришла раньше.',
      '',
      '<b>Полный текст заявки</b>',
      '<blockquote expandable>Нужен сайт для клиники.',
      'Услуги, врачи, запись.</blockquote>',
      '',
      LINK,
    ])
  })

  it('FR-LEAD-7: an empty reading field is skipped, not shown as an empty block', () => {
    const msg = analysisMessages({
      ...full,
      analysis: { ...ANALYSIS, reading: { ...READING, who: '  ', risks: '' } },
    }).join('')
    expect(msg).not.toContain('Кто это')
    expect(msg).not.toContain('<b>Риски</b>')
    expect(msg).toContain('<b>Какую задачу решает для клиента</b>')
  })
})

describe('the texts', () => {
  it('NFR-UX-1: the summary counts orders in the right Russian form', () => {
    expect(TEXTS.summaryHead(1)).toBe('Сегодня отсеяла 1 заявку. На грани:')
    expect(TEXTS.summaryHead(3)).toBe('Сегодня отсеяла 3 заявки. На грани:')
    expect(TEXTS.summaryHead(11)).toBe('Сегодня отсеяла 11 заявок. На грани:')
    expect(TEXTS.summaryNone(21)).toBe('Сегодня отсеяла 21 заявку, пограничных не было')
    expect(TEXTS.summaryNone(25)).toBe('Сегодня отсеяла 25 заявок, пограничных не было')
  })

  it('NFR-UX-1: the proposal counts decisions in the right Russian form', () => {
    const last = (b: { checked: number; changed: number }) =>
      TEXTS.proposal(1, 'с', 'п', ['Порог: 56 → 60'], { ...b, towardBoris: 1, against: 0 })
        .split('\n')
        .at(-1)
    expect(last({ checked: 21, changed: 1 })).toBe(
      'На последних 21 заявке это изменило бы 1 решение: 1 в твою сторону, 0 против.',
    )
    expect(last({ checked: 100, changed: 3 })).toBe(
      'На последних 100 заявках это изменило бы 3 решения: 1 в твою сторону, 0 против.',
    )
    expect(last({ checked: 100, changed: 12 })).toBe(
      'На последних 100 заявках это изменило бы 12 решений: 1 в твою сторону, 0 против.',
    )
  })

  it('NFR-UX-1: the edit texts are exact and count characters in the right form', () => {
    expect(TEXTS.askDraft('Сайт')).toBe(
      'Пришли новый текст отклика на «Сайт» ответом на это сообщение, текстом или голосом. Приветствие я добавлю сама. Цену услуги можно прислать отдельной строкой, например «цена 5000».',
    )
    expect(TEXTS.noDraft).toBe('Сначала нажми «Изменить» и пришли текст отклика')
    expect(TEXTS.draftTooLong(621)).toBe(
      'С приветствием выходит 621 знак, а Профи.ру принимает до 500. Пришли текст короче.',
    )
    expect(TEXTS.draftTooLong(605)).toBe(
      'С приветствием выходит 605 знаков, а Профи.ру принимает до 500. Пришли текст короче.',
    )
  })

  it('NFR-UX-1: the fixed texts of the card and the «Разбор» message contain no long dash', () => {
    const long = `${'а'.repeat(5000)}`
    const texts = [
      leadCardText(card),
      leadCardText({ ...card, verdict: 'maybe' }),
      leadCardText(full),
      leadCardText({ ...full, reminder: true, draft: { ...DRAFT, priceRub: null } }),
      leadCardText({ ...full, text: long }),
      ...analysisMessages(full),
      ...analysisMessages(card),
      ...analysisMessages({ ...full, text: long }),
      TEXTS.bound,
      TEXTS.alreadyDone,
      TEXTS.bidSent('Сайт', 210),
      TEXTS.reminder('Сайт'),
      TEXTS.bidsPaused,
      TEXTS.skipped,
      TEXTS.bidQueued,
      TEXTS.askDraft('Сайт'),
      TEXTS.waitingDraft,
      TEXTS.noDraft,
      TEXTS.draftTooLong(621),
      TEXTS.draftSaved('Сайт'),
      TEXTS.noted('причина', 'Сайт'),
      TEXTS.whichQuestion([TEXTS.waitingFor.edit_draft('Сайт'), TEXTS.waitingFor.why_skip('Сайт')]),
      TEXTS.draftLate,
      TEXTS.wantCard,
      TEXTS.cardSent,
      TEXTS.analysisSent,
      TEXTS.analysisFailed,
      TEXTS.noTask,
    ]
    for (const t of texts) expect(t).not.toContain(DASH)
    // The minus of the reviews is the mathematical one, not a dash.
    expect(leadCardText(full)).toContain('−1')
  })
})

describe('what Sara says when a bid does not go (B1)', () => {
  const CLASSES = [
    'SESSION_DEAD',
    'BANNED',
    'LAYOUT_CHANGED',
    'NOT_FOUND',
    'ORDER_CLOSED',
    'NO_MONEY',
    'UNSAFE_PAYMENT',
    'RATE_LIMITED',
    'INTERNAL',
  ] as const

  it('FR-LEAD-8: every refusal of the node has its own plain words, with the order and what to do', () => {
    const said = CLASSES.map((c) => TEXTS.bidRefused('Сайт для клиники', c))
    expect(new Set(said).size).toBe(CLASSES.length)
    for (const t of said) {
      expect(t).toMatch(/^Отклик на «Сайт для клиники» не ушёл: /)
      expect(t).not.toContain(DASH)
    }
    expect(TEXTS.bidRefused('Сайт', 'NO_MONEY')).toContain('Пополни кошелёк')
    expect(TEXTS.bidRefused('Сайт', 'SESSION_DEAD')).toContain('Войди')
  })

  it('FR-LEAD-9: a dearer bid says the new fee when it is known', () => {
    expect(TEXTS.bidDearer('Сайт', 210, 250)).toContain(`теперь стоит 250${NBSP}₽`)
    expect(TEXTS.bidDearer('Сайт', 210, null)).toContain('Посмотри заявку на Профи.ру')
    for (const t of [
      TEXTS.bidDearer('Сайт', 210, 250),
      TEXTS.bidDearer('Сайт', 210, null),
      TEXTS.bidAlreadyThere('Сайт'),
      TEXTS.bidFoundLater('Сайт', 210),
      TEXTS.bidStale('Сайт'),
      TEXTS.askPrice('Сайт'),
      TEXTS.feeUnknown('Сайт'),
      TEXTS.feeChecking,
    ])
      expect(t).not.toContain(DASH)
  })
})
