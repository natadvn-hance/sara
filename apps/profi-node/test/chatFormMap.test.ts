import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { rawEvent } from '../src/db/schema'
import { type ChatFormMap, readChatFormMap } from '../src/eyes/chatFormMap'
import { createEyes } from '../src/eyes/eyes'
import { startInsurance } from '../src/eyes/insurance'
import { profiParsers } from '../src/eyes/profiParsers'
import { chatHtml, type FakeChat, type FakeProfi, serveFakeProfi } from './helpers/chatPage'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'

const { db, close } = openNodeTestDb()
let ab: AccountBrowser
beforeAll(async () => {
  ab = await openAccountBrowser({
    accountId: 'chat-form-test',
    profileDir: await mkdtemp(join(tmpdir(), 'cf-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
}, 60000)
afterAll(async () => {
  await ab.close()
  await close()
})
beforeEach(() => resetNodeDb(db))

const CLIENT_WORDS = 'Здравствуйте, мой телефон 8 900 123-45-67, жду КП'
const OUR_WORDS = 'Ирина, добрый день! Сделаем сайт с онлайн-записью.'
const DRAFT = 'черновик Бориса, не читать'
const CHAT: FakeChat = {
  messages: [
    { id: '101', side: 'specialist', text: OUR_WORDS },
    { id: '102', side: 'client', text: CLIENT_WORDS },
  ],
}

describe('the map of the chat message box (M4, calibrating the send)', () => {
  it('FR-CONV-9: the map holds the field, the buttons and the attachments control, never a message or a draft', async () => {
    await ab.page.setContent(chatHtml('94001133', CHAT))
    await ab.page.fill('textarea', DRAFT)
    const map = await readChatFormMap(ab.page)
    expect(map?.what).toBe('chat_form')
    // Old Sara's two selectors both find exactly one thing on this page.
    expect(map?.oldInput).toBe(1)
    expect(map?.oldSend).toBe(1)
    expect(map?.fields).toContainEqual(
      expect.objectContaining({ tag: 'textarea', placeholder: 'Сообщение', inBox: true }),
    )
    expect(map?.fields).toContainEqual(
      expect.objectContaining({
        tag: 'input',
        type: 'file',
        accept: 'image/*,.pdf',
        multiple: true,
        visible: false,
      }),
    )
    expect(map?.box).toMatchObject({ tag: 'div', classes: ['cw_composer'] })
    expect(map?.chain.map((c) => c.classes[0])).toEqual(['cw_row', 'cw_inner', 'cw_composer'])
    expect(map?.buttons.map((b) => [b.aria, b.lastOfParent, b.icons])).toEqual([
      ['Прикрепить файл', false, 1],
      ['Голосовое сообщение', true, 1],
    ])
    expect(map?.attachments).toContainEqual(
      expect.objectContaining({ aria: 'Прикрепить файл', tag: 'button' }),
    )
    expect(map?.attachments).toContainEqual(
      expect.objectContaining({ type: 'file', accept: 'image/*,.pdf' }),
    )
    const all = JSON.stringify(map)
    for (const secret of [CLIENT_WORDS, OUR_WORDS, DRAFT, 'Иван Клиентов', '900'])
      expect(all).not.toContain(secret)
    // Nothing was typed or pressed: the draft is still there.
    expect(await ab.page.inputValue('textarea')).toBe(DRAFT)
  })

  it('FR-CONV-9: long numbers in test ids, labels and classes (an order or chat number) are left out of the map', async () => {
    await ab.page.setContent(
      `<div data-testid="chat-94001133"><div class="room-94001133"><div data-testid="composer_94001133">
<textarea placeholder="Сообщение" aria-label="Написать в чат 94001133" name="m94001133"></textarea>
<button aria-label="Отправить в чат 94001133" data-testid="send-94001133" class="btn-94001133">В чат 94001133</button>
</div></div></div>`,
    )
    const map = await readChatFormMap(ab.page)
    expect(map).not.toBeNull()
    const all = JSON.stringify(map)
    expect(all).not.toMatch(/\d{5,}/)
    // The shape is still there: numbers became 0, short numbers (an index, a size) stay.
    expect(map?.testids).toContain('chat-0')
    expect(map?.buttons[0]).toMatchObject({ aria: 'Отправить в чат 0', testid: 'send-0' })
  })

  it('FR-CONV-9: a page without a field to write in has no map yet', async () => {
    await ab.page.setContent(chatHtml('1', { ...CHAT, box: 'none' }))
    expect(await readChatFormMap(ab.page)).toBeNull()
  })

  it('FR-CONV-9: a page whose field old Sara would not find still leaves a map showing the field it has', async () => {
    await ab.page.setContent(
      '<div><div><div><textarea placeholder="Напишите сообщение"></textarea><button aria-label="Отправить"><svg></svg></button></div></div></div>',
    )
    const map = await readChatFormMap(ab.page)
    expect(map?.oldInput).toBe(0)
    expect(map?.oldSend).toBe(0)
    expect(map?.fields[0]).toMatchObject({ tag: 'textarea', placeholder: 'Напишите сообщение' })
    expect(map?.buttons[0]).toMatchObject({ aria: 'Отправить' })
  })
})

describe('the chat sweep records the message box once', () => {
  const site: FakeProfi = { chats: new Map(), presses: [], opened: [] }
  beforeAll(async () => {
    await serveFakeProfi(ab.page, site)
  })
  beforeEach(() => {
    site.chats = new Map([
      ['1001', structuredClone(CHAT)],
      ['1002', structuredClone(CHAT)],
      ['1003', { ...structuredClone(CHAT), box: 'none' }],
    ])
    site.presses = []
    site.opened = []
  })

  const sweep = (chats: string[]) => {
    const eyes = createEyes({ accountId: 'chat-form-test', db, parsers: profiParsers })
    const ins = startInsurance({
      eyes,
      ab,
      baseUrl: 'http://profi.test',
      parsers: {
        ...profiParsers,
        fromChatsDom: async () => chats.map((chatId) => ({ chatId, unread: 1, lastAt: null })),
      },
      feedEveryMs: 3_600_000,
      chatsEveryMs: 3_600_000,
      chatPauseMs: 10,
    })
    return ins
  }
  const maps = async () =>
    (await db.select().from(rawEvent)).filter(
      (r) => r.kind === 'dom' && (r.body as { what?: string }).what === 'chat_form',
    )

  it('FR-CONV-9: two chats read in a sweep leave one map, without message text and without the chat number', async () => {
    const ins = sweep(['1001', '1002'])
    await ins.chatsOnce(false)
    await ins.chatsOnce(false)
    ins.stop()
    expect(site.opened.filter((id) => id === '1001' || id === '1002')).toEqual([
      '1001',
      '1002',
      '1001',
      '1002',
    ])
    const kept = await maps()
    expect(kept).toHaveLength(1)
    const body = kept[0]?.body as ChatFormMap
    expect(body.oldInput).toBe(1)
    expect(kept[0]?.url).toBe('http://profi.test/backoffice/r.php?id=0')
    const all = JSON.stringify(kept[0])
    for (const secret of [CLIENT_WORDS, OUR_WORDS, 'Иван Клиентов'])
      expect(all).not.toContain(secret)
    // Only reading: nothing was typed or pressed.
    expect(site.presses).toEqual([])
  }, 60000)

  it('FR-CONV-9: a chat page without a message box leaves no map, the next chat that has one does', async () => {
    const ins = sweep(['1003', '1001'])
    await ins.chatsOnce(false)
    ins.stop()
    const kept = await maps()
    expect(kept).toHaveLength(1)
    const body = kept[0]?.body as ChatFormMap
    expect(body.oldInput).toBe(1)
  }, 60000)
})
