import type { Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import {
  authorFromReaders,
  chatHistory,
  HISTORY_FLAG,
  HISTORY_STATUS,
  type HistoryDeps,
  listedChats,
  readHistory,
} from '../src/eyes/history'
import type { StoredMessage } from '../src/store/raw'

// Shapes of the live answers of 28.10.2026, without names or texts of clients.
const edge = (id: string, filter: string, unread: number, last: string) => ({
  node: {
    messengerType: 'ORDER',
    messengerExtId: id,
    order: { rboFilterId: filter },
    chats: [{ unreadMessageCount: unread, lastMessage: { dateCreated: last } }],
  },
})
const list = (total: number, ...edges: unknown[]) => ({
  data: { me: { rboMessengersByFilter: { totalCount: total, edges } } },
})
const msg = (id: string, at: string, readers: string[], text = 'текст') => ({
  _id: id,
  dateCreated: at,
  text,
  whoRead: readers.map((t) => ({ extUserType: t })),
})
const chat = (hasPrev: boolean, ...messages: unknown[]) => ({
  data: { messengerChatMessages: { hasPrev, hasNext: false, messages } },
})
const OLD = 'Wed Sep 16 2026 12:51:00 GMT+0300 (MSK)'
const NOW = Date.parse('2026-10-28T15:00:00Z')

describe('the archive reader: the site answers', () => {
  it('FR-TRAIN-1: the lists name every order chat, its tab, unread count and last time; the newest answer wins', () => {
    const r = listedChats([
      list(2, edge('1', 'open', 1, OLD), edge('2', 'open', 0, OLD)),
      list(3, edge('3', 'archive', 0, 'Wed Jul 30 2026 17:32:39 GMT+0300 (MSK)')),
      list(2, edge('1', 'open', 0, OLD)),
      { data: { me: { profile: {} } } },
    ])
    expect(r.total).toEqual({ open: 2, archive: 3 })
    expect(r.chats).toHaveLength(3)
    expect(r.chats.find((c) => c.orderId === '1')).toEqual({
      orderId: '1',
      filter: 'open',
      unread: 0,
      lastAt: '2026-09-16T09:51:00.000Z',
    })
    expect(r.chats.find((c) => c.orderId === '3')?.filter).toBe('archive')
  })

  it('FR-TRAIN-1: whose a message is comes from who read it', () => {
    expect(authorFromReaders(['PROFILE', 'SESSION'])).toBe('client')
    expect(authorFromReaders(['CLIENT', 'SESSION'])).toBe('specialist')
    expect(authorFromReaders([])).toBe('specialist')
    expect(authorFromReaders(['CLIENT', 'PROFILE', 'SESSION'])).toBe('system')
  })

  it('FR-TRAIN-1: a chat is its messages in time order with their real time, once each, deleted ones left out', () => {
    const h = chatHistory(
      [
        chat(true, msg('20', 'Wed Sep 16 2026 13:00:00 GMT+0300 (MSK)', ['PROFILE', 'SESSION'])),
        chat(
          false,
          msg('10', OLD, ['CLIENT', 'SESSION'], 'отклик'),
          msg('20', 'Wed Sep 16 2026 13:00:00 GMT+0300 (MSK)', ['PROFILE', 'SESSION']),
          { ...msg('15', OLD, []), isDeleted: true },
        ),
      ],
      '94001133',
    )
    expect(h.complete).toBe(true)
    expect(h.messages.map((m) => [m.platform_message_id, m.author, m.sent_at])).toEqual([
      ['10', 'specialist', '2026-09-16T09:51:00.000Z'],
      ['20', 'client', '2026-09-16T10:00:00.000Z'],
    ])
    expect(h.messages[0]).toMatchObject({
      chat_id: '94001133',
      order_id: '94001133',
      text: 'отклик',
      read: true,
    })
    expect(chatHistory([chat(true, msg('1', OLD, []))], '1').complete).toBe(false)
  })
})

/** A stand-in for the node: a tab that answers each page with the given list and chat answers. */
function stand(o: {
  lists: unknown[]
  chats: Record<string, unknown[]>
  known?: string[]
  pageFails?: (path: string) => boolean
  body?: string
  flagAfter?: number
}) {
  const visited: string[] = []
  const kept: StoredMessage[] = []
  const flags = new Map<string, string>([[HISTORY_FLAG, 'go']])
  let current = ''
  let flagReads = 0
  const guard = { goes: 0 }
  // A page that fails answers nothing, the way a chat page that never loads leaves no answer of the site behind.
  const page = {
    url: () => `https://profi.ru${current}`,
    goto: async (url: string) => {
      current = url.replace('https://profi.ru', '')
      visited.push(current)
      if (o.pageFails?.(current)) throw new Error('Timeout 30000ms exceeded')
      return null
    },
    locator: () => ({ innerText: async () => o.body ?? 'Чаты' }),
    evaluate: async () => {},
  } as unknown as Page
  const d: HistoryDeps = {
    inTab: (f) =>
      f({
        go: async () => {
          guard.goes++
          return true
        },
        can: () => true,
        later: () => {},
      }),
    page: () => page,
    flag: async () => {
      flagReads++
      if (o.flagAfter !== undefined && flagReads > o.flagAfter) return 'stop'
      return flags.get(HISTORY_FLAG) ?? null
    },
    setFlag: async (name, reason) => void flags.set(name, reason),
    answers: async (kind) => {
      if (o.pageFails?.(current)) return []
      if (kind === 'list') return o.lists
      const id = /id=(\d+)/.exec(current)?.[1] ?? ''
      return o.chats[id] ?? []
    },
    knownChat: async (id) => (o.known ?? []).includes(id),
    keep: async (m) => {
      kept.push(...m)
      return m.length
    },
    baseUrl: 'https://profi.ru',
    chatsPath: '/backoffice/r.php',
    chatPath: (id, filter) =>
      `/backoffice/r.php?id=${id}${filter === 'archive' ? '&filter=archive' : ''}`,
    sleep: async () => {},
    now: () => NOW,
    log: () => {},
  }
  return { d, visited, kept, flags, guard }
}

describe('the archive reader: one pass', () => {
  it('FR-TRAIN-1: reads both lists, then each quiet chat once; unread, fresh and known chats are left to the live check', async () => {
    const s = stand({
      lists: [
        list(
          3,
          edge('1', 'open', 0, OLD),
          edge('2', 'open', 2, OLD),
          edge('3', 'open', 0, 'Wed Oct 28 2026 12:00:00 GMT+0300 (MSK)'),
        ),
        list(2, edge('4', 'archive', 0, OLD), edge('5', 'archive', 0, OLD)),
      ],
      chats: {
        '1': [chat(false, msg('11', OLD, ['CLIENT']))],
        '4': [chat(false, msg('41', OLD, ['CLIENT']), msg('42', OLD, ['PROFILE']))],
      },
      known: ['5'],
    })
    const line = await readHistory(s.d)
    expect(s.visited).toEqual([
      '/backoffice/r.php',
      '/backoffice/r.php?filter=archive',
      '/backoffice/r.php?id=1',
      '/backoffice/r.php?id=4&filter=archive',
    ])
    expect(s.kept.map((m) => m.platform_message_id)).toEqual(['11', '41', '42'])
    expect(line).toBe('готово: прочитано 2 чатов из 2, сообщений 3, неполных 0')
    expect(s.flags.get(HISTORY_FLAG)).toBe('done')
    expect(s.flags.get(HISTORY_STATUS)).toBe(line)
  })

  it('FR-TRAIN-1: stops for good when the chat list gives no answer', async () => {
    const s = stand({
      lists: [list(1, edge('1', 'open', 0, OLD))],
      chats: {},
      pageFails: (p) => p === '/backoffice/r.php',
    })
    expect(await readHistory(s.d)).toBe('остановлено: список чатов не ответил')
    expect(s.visited).toEqual(['/backoffice/r.php'])
    expect(s.flags.get(HISTORY_FLAG)).toBe('stopped')
  })

  it('FR-TRAIN-1: a page whose «load» never comes but whose answer does is read; misses never reach the connection guard', async () => {
    const s = stand({
      lists: [list(2, edge('1', 'open', 0, OLD), edge('2', 'open', 0, OLD))],
      chats: { '2': [chat(false, msg('21', OLD, ['CLIENT']))] },
      pageFails: (p) => p.includes('id=1'),
    })
    expect(await readHistory(s.d)).toBe('готово: прочитано 1 чатов из 2, сообщений 1, неполных 0')
    expect(s.kept.map((m) => m.platform_message_id)).toEqual(['21'])
    expect(s.guard.goes).toBe(0)
  })

  it('FR-TRAIN-1: a page that looks like a block stops the pass before any chat', async () => {
    const s = stand({ lists: [], chats: {}, body: 'Слишком много запросов, попробуйте позже' })
    expect(await readHistory(s.d)).toBe('остановлено: страница похожа на блокировку')
    expect(s.visited).toEqual(['/backoffice/r.php'])
  })

  it('FR-TRAIN-1: two chats in a row without messages stop the pass', async () => {
    const s = stand({
      lists: [
        list(3, edge('1', 'open', 0, OLD), edge('2', 'open', 0, OLD), edge('3', 'open', 0, OLD)),
      ],
      chats: {},
    })
    expect(await readHistory(s.d)).toBe(
      'остановлено: два чата подряд без сообщений, прочитано 0 из 3',
    )
    expect(s.visited.filter((p) => p.includes('id='))).toHaveLength(2)
  })

  it('FR-TRAIN-1: the operator takes the flag off and the pass stops before the next chat', async () => {
    const s = stand({
      lists: [list(2, edge('1', 'open', 0, OLD), edge('2', 'open', 0, OLD))],
      chats: {
        '1': [chat(false, msg('11', OLD, ['CLIENT']))],
        '2': [chat(false, msg('21', OLD, ['CLIENT']))],
      },
      flagAfter: 3,
    })
    expect(await readHistory(s.d)).toBe('остановлено: флаг снят, прочитано 1 из 2')
    expect(s.kept.map((m) => m.platform_message_id)).toEqual(['11'])
  })
})
