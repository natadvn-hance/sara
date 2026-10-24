import { describe, expect, it } from 'vitest'
import { redact, restore } from '../../src/gateway/redact'

describe('redaction before the model', () => {
  it('NFR-PRIV-2: phones become tags in every usual spelling', () => {
    const r = redact(
      'Звоните +7 (916) 123-45-67, 8 916 123 45 67, 89161234567, 916-123-45-67, +375 29 123-45-67 или 123-45-67',
    )
    expect(r.text).toBe(
      'Звоните [телефон 1], [телефон 2], [телефон 3], [телефон 4], [телефон 5] или [телефон 6]',
    )
    expect(r.counts).toEqual({ phone: 6, email: 0, link: 0, name: 0 })
  })

  it('NFR-PRIV-2: prices, dates, ranges and tech names stay as they are', () => {
    const text =
      'Бюджет 50 000 ₽, срок 24.10.2026 или 2026-10-24, от 30000 до 50000, 1500-2000 руб., 2 000 000 руб, 1 500 000 000 руб, +1 500 000 руб, 8 часов, заказ 123456789, сайт на ASP.NET и Vue.js, стек Node.js/React'
    expect(redact(text).text).toBe(text)
  })

  it('NFR-PRIV-2: e-mails, links and handles become tags, the punctuation after a link stays', () => {
    const r = redact(
      'Пишите ivan.petrov@mail.ru или иван@почта.рф. Сайт https://shop.example.com/catalog?id=5, www.hance.ru и vk.com/id123 (страница). Ещё t.me/ivan_p, site.ru, @ivan_petrov и ＠anna.',
    )
    expect(r.text).toBe(
      'Пишите [почта 1] или [почта 2]. Сайт [ссылка 1], [ссылка 2] и [ссылка 3] (страница). Ещё [ссылка 4], [ссылка 5], [ссылка 6] и [ссылка 7].',
    )
    expect(r.counts).toEqual({ phone: 0, email: 2, link: 7, name: 0 })
  })

  it('NFR-PRIV-2: phones without the country code, with long area codes or with dots are hidden', () => {
    const r = redact(
      'Тел 495 1234567, 4951234567, (812)1234567, (495) 123-45-67, 8 (8452) 12-34-56, 8 (34342) 2-12-34, 12-34-56, 916.123.45.67',
    )
    expect(r.text).toBe(
      'Тел [телефон 1], [телефон 2], [телефон 3], [телефон 4], [телефон 5], [телефон 6], [телефон 7], [телефон 8]',
    )
  })

  it('NFR-PRIV-2: a phone takes neither the number after it nor the next line', () => {
    expect(redact('+7 916 123 45 67 10 дней\n8 916 123 45 67\n5 штук').text).toBe(
      '[телефон 1] 10 дней\n[телефон 2]\n5 штук',
    )
  })

  it('NFR-PRIV-2: profile links on short hosts and in capitals are hidden', () => {
    expect(
      redact(
        'taplink.cc/ivan, linktr.ee/ivan, youtu.be/x1, vk.cc/abc, wa.me/79161234567, VK.COM/ivan',
      ).text,
    ).toBe('[ссылка 1], [ссылка 2], [ссылка 3], [ссылка 4], [ссылка 5], [ссылка 6]')
  })

  it('NFR-PRIV-2: inside JSON a link stops before an escape, so the JSON stays whole and comes back the same', () => {
    const rules = { about: 'Наш сайт https://hance.ru\nПишите', note: 'см. "vk.com/hance"' }
    const r = redact(JSON.stringify(rules))
    const seen = JSON.parse(r.text)
    expect(seen).toEqual({ about: 'Наш сайт [ссылка 1]\nПишите', note: 'см. "[ссылка 2]"' })
    expect(restore(seen, r.tags)).toEqual(rules)
  })

  it('NFR-PRIV-2: given names become tags, with case endings for names of 4 letters and more', () => {
    const r = redact(
      'Иван Петров просит. Ивану удобно вечером. Ян тоже. Янтарь и январь не имена.',
      ['Иван Петров', 'Иван', 'Ян', null, ' '],
    )
    expect(r.text).toBe(
      '[имя 1] просит. [имя 2] удобно вечером. [имя 3] тоже. Янтарь и январь не имена.',
    )
  })

  it('NFR-PRIV-2: only real case endings and both е and ё count, so common words stay', () => {
    const r = redact(
      'Ника никак не ответит. Виктор любит викторины. Марк зашёл в маркет. Дина болеет за Динамо. Пётр и Петра ждут, Марии нет, Ольге пишем.',
      ['Ника', 'Виктор', 'Марк', 'Дина', 'Петр', 'Мария', 'Ольга'],
    )
    expect(r.text).toBe(
      '[имя 1] никак не ответит. [имя 2] любит викторины. [имя 3] зашёл в маркет. [имя 4] болеет за Динамо. [имя 5] и [имя 6] ждут, [имя 7] нет, [имя 8] пишем.',
    )
  })

  it('NFR-PRIV-2: one value gets one tag, and a tag already in the text is never reused', () => {
    const r = redact('Тел 89161234567, ещё раз 89161234567. В шаблоне [телефон 1] и [имя 2].', [
      'Олег',
    ])
    expect(r.text).toBe('Тел [телефон 2], ещё раз [телефон 2]. В шаблоне [телефон 1] и [имя 2].')
    expect(restore('[телефон 1] [телефон 2]', r.tags)).toBe('[телефон 1] 89161234567')
  })

  it('NFR-PRIV-2: restore puts values back in every string of the answer, unknown tags stay', () => {
    const { tags } = redact('Олег, 89161234567, oleg@mail.ru', ['Олег'])
    expect(
      restore(
        {
          text: '[имя 1], позвоню на [Телефон1]',
          list: ['[почта 1]', 3, null, { deep: '[ссылка 9] и [телефон 1]' }],
          n: 5,
          ok: true,
        },
        tags,
      ),
    ).toEqual({
      text: 'Олег, позвоню на 89161234567',
      list: ['oleg@mail.ru', 3, null, { deep: '[ссылка 9] и 89161234567' }],
      n: 5,
      ok: true,
    })
  })
})

describe('redaction on long inputs', () => {
  it('NFR-PRIV-2: a long input is hidden in well under a second', () => {
    const long = [
      'x'.repeat(100_000),
      'слово '.repeat(20_000),
      '1'.repeat(50_000),
      'a.'.repeat(30_000),
      '@'.repeat(10_000),
    ].join(' ')
    const started = performance.now()
    redact(`${long} oleg@mail.ru`, ['Олег'])
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
