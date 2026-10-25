import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeText } from '@sara/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readTelegramExport, readTelegramV1Texts } from '../../src/history/telegramExport'

let dir: string
let file: string

// Boris's chat with the old bot as Telegram Desktop exports it: text is a string or a list of parts.
const exported = {
  name: 'Sara',
  type: 'bot_chat',
  id: 1,
  messages: [
    {
      id: 1,
      type: 'message',
      from: 'Sara',
      from_id: 'user1',
      text: '🤖 Sara ответила\nЗаказ 1001 · Сайты\n\nДобрый день! Удобно созвониться завтра?\n\nСсылка',
    },
    {
      id: 2,
      type: 'message',
      from: 'Sara',
      from_id: 'user1',
      text: [
        '🔁 ',
        { type: 'bold', text: 'Напоминание №1' },
        '\nЗаказ 1002 · Сайты\nНе отвечал.\n\n',
        { type: 'blockquote', text: 'Если вопрос ещё открыт, пишите.\n\nХорошего дня!' },
        '\n\n',
        { type: 'text_link', text: 'Ссылка', href: 'https://example.test/order/1002' },
      ],
    },
    {
      id: 3,
      type: 'message',
      from: 'Sara',
      from_id: 'user1',
      text: [
        '✅ ',
        { type: 'bold', text: 'Отклик отправлен' },
        '\nЗаказ 1003 · Сайты\nЦена: 1000-2000 ₽\n\nЗдравствуйте! Сделаем сайт.\n\nСсылка',
      ],
    },
    {
      id: 4,
      type: 'message',
      from: 'Sara',
      from_id: 'user1',
      text: '🤖 Sara ответила по твоему «да»\nЗаказ 1005 · Сайты\n\nТогда до четверга!\n\nСсылка',
    },
    // Boris's own words that v1 only carried to the client are not v1's.
    {
      id: 5,
      type: 'message',
      from: 'Sara',
      from_id: 'user1',
      text: '🤖 Отправила клиенту твой текст\nЗаказ 1004 · Сайты\n\nЦена 80 тысяч\n\nСсылка',
    },
    { id: 6, type: 'message', from: 'Борис', from_id: 'user42', text: 'Да' },
    // Boris's own message that happens to start with the same icon is not a notice of the bot.
    {
      id: 9,
      type: 'message',
      from: 'Борис',
      from_id: 'user42',
      text: '🤖 Сара, ответь так\n\nНапишу сам завтра',
    },
    {
      id: 7,
      type: 'message',
      from: 'Sara',
      from_id: 'user1',
      text: '💬 Ответ клиента\nЗаказ 1001 · Сайты\n\nСколько стоит?\n\nСсылка',
    },
    { id: 8, type: 'service', action: 'pin_message', text: '' },
  ],
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sara-tg-'))
  file = join(dir, 'result.json')
  await writeFile(file, JSON.stringify(exported))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('telegram export', () => {
  it('FR-TRAIN-1: the texts v1 sent to clients come out of its notices, normalized', () => {
    expect([...readTelegramV1Texts(file)].sort()).toEqual(
      [
        'Добрый день! Удобно созвониться завтра?',
        'Если вопрос ещё открыт, пишите.\n\nХорошего дня!',
        'Здравствуйте! Сделаем сайт.',
        'Тогда до четверга!',
      ]
        .map(normalizeText)
        .sort(),
    )
  })

  it('FR-TRAIN-1: a file that is not a chat export is an error', async () => {
    const other = join(dir, 'other.json')
    await writeFile(other, JSON.stringify({ chats: [] }))
    expect(() => readTelegramV1Texts(other)).toThrow(/messages/)
  })

  it('FR-TRAIN-1: only the bot’s notices count, and the ones with Boris’s words prove his voice', () => {
    const r = readTelegramExport(file)
    expect([...r.v1Texts]).not.toContain(normalizeText('Напишу сам завтра'))
    expect([...r.borisTexts]).toEqual([normalizeText('Цена 80 тысяч')])
  })
})
