import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SendMessageInput } from '@sara/shared'
import { signMessagePermit } from '@sara/shared/permit'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { createSendTools } from '../src/chat/sendTools'
import { messageAttempt, rawEvent, rawMessage } from '../src/db/schema'
import { createEyes, type Eyes } from '../src/eyes/eyes'
import { type Insurance, startInsurance } from '../src/eyes/insurance'
import { profiParsers } from '../src/eyes/profiParsers'
import { ProfiToolError } from '../src/mcp/server'
import { saveMessagePress } from '../src/store/raw'
import type { SessionState } from '../src/watch/sessionWatch'
import { FAKE_ORIGIN, type FakeChat, type FakeProfi, serveFakeProfi } from './helpers/chatPage'
import { nodeTestUrl, openNodeTestDb, resetNodeDb } from './helpers/db'

const ACCOUNT = 'hance-marketing'
const SECRET = 'send-test-secret'
const { db, close } = openNodeTestDb()
const site: FakeProfi = { chats: new Map(), presses: [], opened: [] }
let ab: AccountBrowser
let eyes: Eyes
let ins: Insurance
let state: SessionState = 'alive'
let may = true
// What the field held when the work in the tab ended (the tab then leaves the page).
let fieldAtEnd: string | null = null

const OURS = 'Ирина, добрый день! Сделаем сайт с онлайн-записью.'
const CLIENTS = 'Здравствуйте, сколько это будет стоить?'
const REPLY = 'Ирина, от 40 000 ₽. Когда удобно созвониться?'
const chat = (): FakeChat => ({
  messages: [
    { id: '101', side: 'specialist', text: OURS },
    { id: '102', side: 'client', text: CLIENTS },
  ],
})

beforeAll(async () => {
  ab = await openAccountBrowser({
    accountId: ACCOUNT,
    profileDir: await mkdtemp(join(tmpdir(), 'send-')),
    proxy: null,
    headless: true,
    databaseUrl: nodeTestUrl(),
  })
  await serveFakeProfi(ab.page, site)
}, 60000)
afterAll(async () => {
  await ab.close()
  await close()
})
beforeEach(async () => {
  await resetNodeDb(db)
  site.chats = new Map([['c1', chat()]])
  site.presses = []
  site.opened = []
  state = 'alive'
  may = true
  fieldAtEnd = null
  eyes = createEyes({ accountId: ACCOUNT, db, parsers: profiParsers })
  ins = startInsurance({
    eyes,
    ab,
    baseUrl: FAKE_ORIGIN,
    parsers: profiParsers,
    feedEveryMs: 3_600_000,
    chatsEveryMs: 3_600_000,
    canNavigate: () => may,
  })
})
afterEach(async () => {
  // The answer of work in the tab comes before the tab is back on the feed: let the tail of this test finish.
  await ins.inTab(async () => null)
  await ins.inTab(async () => null)
  ins.stop()
})

const tools = (o: Partial<Parameters<typeof createSendTools>[0]> = {}) =>
  createSendTools({
    db,
    permitSecret: SECRET,
    parsers: profiParsers,
    enabled: true,
    accounts: new Map([
      [
        ACCOUNT,
        {
          watch: { state: () => state },
          eyes,
          page: () => ab.page,
          inTab: (f) =>
            ins.inTab(async (t) => {
              try {
                return await f(t)
              } finally {
                fieldAtEnd = await ab.page
                  .locator('textarea')
                  .inputValue({ timeout: 500 })
                  .catch(() => null)
              }
            }),
        },
      ],
    ]),
    stableMs: 50,
    pollMs: 100,
    confirmMs: 3000,
    boxMs: 3000,
    queueMs: 5000,
    // No pace in tests: the keys are still pressed one by one.
    typing: { charMs: [0, 0], lookMs: [0, 0], budgetMs: 1000 },
    ...o,
  })

/** An input signed like the core signs it; a given permit is kept as it is. */
const msg = (text: string, more: Partial<SendMessageInput> = {}): SendMessageInput => {
  const base = {
    account_id: ACCOUNT,
    chat_id: 'c1',
    text,
    expect_last_message_id: '102' as string | null,
    idempotency_key: `k-${Math.random()}`,
    ...more,
  }
  const permit =
    more.permit ??
    signMessagePermit(SECRET, {
      accountId: base.account_id,
      chatId: base.chat_id,
      text: base.text,
      key: base.idempotency_key,
    })
  return { ...base, permit }
}

/** Holds the account tab with work of its own, from the moment that work has it until release() is called. */
async function holdTab() {
  let release: () => void = () => {}
  let has: () => void = () => {}
  const has_ = new Promise<void>((r) => (has = r))
  const done = ins.inTab(
    () =>
      new Promise<null>((r) => {
        release = () => r(null)
        has()
      }),
  )
  await has_
  return { release, done }
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof ProfiToolError) return e.errorClass
    throw e
  }
  return 'no error'
}
const c1 = () => site.chats.get('c1') as FakeChat
const attempts = () => db.select().from(messageAttempt)

describe('profi.send_message on the chat page (M4)', () => {
  it('FR-CONV-9: the text is typed into the field and sent once, and the new bubble of our side is found', async () => {
    const out = await tools().sendMessage(msg(REPLY))
    expect(out).toEqual({ found_on_page: true, platform_message_id: 'new-1' })
    expect(site.presses).toEqual([{ chat: 'c1', how: 'works', text: REPLY }])
    expect(site.opened[0]).toBe('c1')
    // The press was written down before it happened and holds its answer, not the text.
    const [row] = await attempts()
    expect(row).toMatchObject({
      chatId: 'c1',
      accountId: ACCOUNT,
      expectLastMessageId: '102',
      result: { found_on_page: true, platform_message_id: 'new-1' },
    })
    expect(JSON.stringify(row)).not.toContain('40 000')
    // The eyes saw the chat too: our new message is stored, with its number from the page.
    const stored = await db.select().from(rawMessage)
    expect(stored.map((m) => [m.platformMessageId, m.author])).toContainEqual([
      'new-1',
      'specialist',
    ])
  }, 60000)

  it('NFR-REL-4: a repeat with the same key answers first and types nothing, also after a restart', async () => {
    const input = msg(REPLY)
    const first = await tools().sendMessage(input)
    const opened = site.opened.length
    // A new tool object and a new tab queue stand for a restart of the node: only the database is the same.
    const again = await tools().sendMessage(input)
    expect(again).toEqual(first)
    expect(site.presses).toHaveLength(1)
    expect(site.opened).toHaveLength(opened)
    expect(await attempts()).toHaveLength(1)
  }, 60000)

  it('NFR-REL-4: a repeat is answered even while the tab is busy with other work', async () => {
    const input = msg(REPLY)
    const first = await tools().sendMessage(input)
    const held = await holdTab()
    expect(await tools({ queueMs: 300 }).sendMessage(input)).toEqual(first)
    held.release()
    await held.done
  }, 60000)

  it('FR-CONV-9: an earlier message of ours with the same words is not mistaken for the new one', async () => {
    site.chats.set('c1', {
      messages: [
        { id: '100', side: 'specialist', text: REPLY },
        { id: '102', side: 'client', text: CLIENTS },
      ],
    })
    const out = await tools().sendMessage(msg(REPLY))
    expect(out.platform_message_id).toBe('new-1')
  }, 60000)

  it('NFR-REL-4: a press written but never answered (the node died after it): a repeat only looks, and finds the message', async () => {
    const input = msg(REPLY)
    await saveMessagePress(db, {
      key: input.idempotency_key,
      accountId: ACCOUNT,
      chatId: 'c1',
      expectLastMessageId: '102',
    })
    // The send did go through before the node died.
    site.chats.get('c1')?.messages.push({ id: '103', side: 'specialist', text: REPLY })
    const out = await tools().sendMessage(input)
    expect(out).toEqual({ found_on_page: true, platform_message_id: '103' })
    expect(site.presses).toEqual([])
    const [row] = await attempts()
    expect(row?.result).toEqual(out)
  }, 60000)

  it('NFR-REL-4: a press written but never answered and no message in the chat is UNCERTAIN, and types nothing', async () => {
    const input = msg(REPLY)
    await saveMessagePress(db, {
      key: input.idempotency_key,
      accountId: ACCOUNT,
      chatId: 'c1',
      expectLastMessageId: '102',
    })
    expect(await failure(tools().sendMessage(input))).toBe('UNCERTAIN')
    expect(site.presses).toEqual([])
    expect(fieldAtEnd).toBe('')
  }, 60000)

  it('NFR-REL-4: an older message with the same words is not our message after the press', async () => {
    // We said the same words before the client's last message: the look starts after what the core saw.
    site.chats.set('c1', {
      messages: [
        { id: '100', side: 'specialist', text: REPLY },
        { id: '102', side: 'client', text: CLIENTS },
      ],
    })
    const input = msg(REPLY)
    await saveMessagePress(db, {
      key: input.idempotency_key,
      accountId: ACCOUNT,
      chatId: 'c1',
      expectLastMessageId: '102',
    })
    expect(await failure(tools().sendMessage(input))).toBe('UNCERTAIN')
  }, 60000)

  it('FR-CONV-6: a message the core had not seen is CHAT_CHANGED, nothing is typed, and the eyes learn the news', async () => {
    site.chats
      .get('c1')
      ?.messages.push({ id: '103', side: 'client', text: 'И ещё вопрос про сроки' })
    expect(await failure(tools().sendMessage(msg(REPLY)))).toBe('CHAT_CHANGED')
    expect(site.presses).toEqual([])
    expect(fieldAtEnd).toBe('')
    expect(await attempts()).toHaveLength(0)
    // The sweep would find it within 10 minutes; the read for the send has already put it in the node's store.
    const stored = await db.select().from(rawMessage)
    expect(stored.map((m) => m.platformMessageId)).toContain('103')
  }, 60000)

  it('FR-CONV-6: a client message that arrives while the text is typed is CHAT_CHANGED, nothing is pressed, the draft is cleared', async () => {
    c1().arriveOnInput = { id: '103', text: 'И ещё вопрос про сроки' }
    expect(await failure(tools().sendMessage(msg(REPLY)))).toBe('CHAT_CHANGED')
    expect(site.presses).toEqual([])
    expect(fieldAtEnd).toBe('')
    // The press was never written, and the eyes know the news at once.
    expect(await attempts()).toHaveLength(0)
    const stored = await db.select().from(rawMessage)
    expect(stored.map((m) => m.platformMessageId)).toContain('103')
  }, 60000)

  it('FR-CONV-6: Boris answered by hand in the meantime: CHAT_CHANGED as well', async () => {
    site.chats.get('c1')?.messages.push({ id: '103', side: 'specialist', text: 'Сам отвечу' })
    expect(await failure(tools().sendMessage(msg(REPLY)))).toBe('CHAT_CHANGED')
    expect(site.presses).toEqual([])
  }, 60000)

  it('FR-CONV-6: null means the chat must be empty: a chat with messages is CHAT_CHANGED, an empty one is written to', async () => {
    expect(await failure(tools().sendMessage(msg(REPLY, { expect_last_message_id: null })))).toBe(
      'CHAT_CHANGED',
    )
    expect(site.presses).toEqual([])
    site.chats.set('c1', { messages: [] })
    const out = await tools().sendMessage(msg(REPLY, { expect_last_message_id: null }))
    expect(out).toEqual({ found_on_page: true, platform_message_id: 'new-1' })
    expect(site.presses).toHaveLength(1)
  }, 60000)

  it('FR-CONV-9: a press the site swallowed is UNCERTAIN, and a repeat with the same key does not type again', async () => {
    c1().send = 'swallowed'
    const input = msg(REPLY)
    expect(await failure(tools({ confirmMs: 600 }).sendMessage(input))).toBe('UNCERTAIN')
    expect(site.presses).toHaveLength(1)
    // The press stays written without an answer.
    const [row] = await attempts()
    expect(row?.result).toBeNull()
    expect(await failure(tools({ confirmMs: 600 }).sendMessage(input))).toBe('UNCERTAIN')
    expect(site.presses).toHaveLength(1)
  }, 60000)

  it('FR-CONV-9: a message that shows up a little after the press is still found', async () => {
    c1().send = 'late'
    const out = await tools({ confirmMs: 5000 }).sendMessage(msg(REPLY))
    expect(out).toEqual({ found_on_page: true, platform_message_id: 'new-1' })
    expect(site.presses).toHaveLength(1)
  }, 60000)

  it('FR-CONV-9: a text with line breaks goes in whole, and no Enter key sends it half-way', async () => {
    c1().enterSends = true
    const text = 'Ирина, добрый день!\n\nПримеры: https://example.com/кейсы\nЖду ответа «в 15:00».'
    const out = await tools().sendMessage(msg(text))
    expect(out.platform_message_id).toBe('new-1')
    expect(site.presses).toEqual([{ chat: 'c1', how: 'works', text }])
  }, 60000)

  it('FR-CONV-9: a draft left in the field is not sent with the new text', async () => {
    c1().draft = 'забытый черновик'
    await tools().sendMessage(msg(REPLY))
    expect(site.presses).toEqual([{ chat: 'c1', how: 'works', text: REPLY }])
  }, 60000)

  it('FR-CONV-9: a field that does not keep the text whole sends nothing and leaves no draft', async () => {
    c1().mangle = true
    expect(await failure(tools().sendMessage(msg(REPLY)))).toBe('INTERNAL')
    expect(site.presses).toEqual([])
    expect(fieldAtEnd).toBe('')
    expect(await attempts()).toHaveLength(0)
  }, 60000)

  it('FR-CONV-9: no field on the page is LAYOUT_CHANGED and sends nothing', async () => {
    c1().box = 'no_field'
    expect(await failure(tools().sendMessage(msg(REPLY)))).toBe('LAYOUT_CHANGED')
    expect(site.presses).toEqual([])
    expect(await attempts()).toHaveLength(0)
  }, 60000)

  it('FR-CONV-9: no send button next to the field is LAYOUT_CHANGED, the typed text is taken back out', async () => {
    c1().box = 'no_buttons'
    expect(await failure(tools().sendMessage(msg(REPLY)))).toBe('LAYOUT_CHANGED')
    expect(site.presses).toEqual([])
    expect(fieldAtEnd).toBe('')
    expect(await attempts()).toHaveLength(0)
  }, 60000)

  it('FR-CONV-2: a chat where no bubble can be told apart (the classes changed) is LAYOUT_CHANGED, not a blind send', async () => {
    const c9 = /\/backoffice\/r\.php\?id=c9$/
    await ab.page.route(c9, (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<div data-message-content-id="7" class="zz_new"><div class="cw_xeDn2R"><div class="cw_BFgZYK">слова</div></div></div><div><div><div><textarea placeholder="Сообщение"></textarea><button>ok</button></div></div></div>',
      }),
    )
    expect(
      await failure(
        tools().sendMessage(msg(REPLY, { chat_id: 'c9', expect_last_message_id: '7' })),
      ),
    ).toBe('LAYOUT_CHANGED')
    await ab.page.unroute(c9)
  }, 60000)

  it('FR-CONV-9: a chat that shows neither bubbles nor a field is NOT_FOUND', async () => {
    expect(
      await failure(tools({ boxMs: 600 }).sendMessage(msg(REPLY, { chat_id: 'nobody' }))),
    ).toBe('NOT_FOUND')
    expect(site.presses).toEqual([])
  }, 60000)

  it('FR-CONV-9: with the node switch off nothing is opened, typed or written', async () => {
    const input = msg(REPLY)
    const err = await tools({ enabled: false })
      .sendMessage(input)
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ProfiToolError)
    expect(err).toMatchObject({
      errorClass: 'INTERNAL',
      message: expect.stringContaining('выключена'),
    })
    expect(site.opened).toEqual([])
    expect(site.presses).toEqual([])
    expect(await attempts()).toHaveLength(0)
  }, 60000)

  it('NFR-SEC-2: a permit for another text, chat or key is refused and nothing is opened', async () => {
    const good = msg(REPLY)
    for (const bad of [
      { ...good, text: `${REPLY} Скидка!` },
      { ...good, chat_id: 'c2' },
      { ...good, idempotency_key: 'another-key' },
      { ...good, permit: 'ab'.repeat(32) },
    ])
      expect(await failure(tools().sendMessage(bad))).toBe('INTERNAL')
    expect(site.opened).toEqual([])
    expect(site.presses).toEqual([])
  }, 60000)

  it('FR-CONV-4: text shaped like protocol (JSON, a parameter tag) is never typed into a client chat', async () => {
    for (const text of [
      '{"message": "Ирина, здравствуйте!"}',
      'Ирина, <parameter name="x">1</parameter>',
    ])
      expect(await failure(tools().sendMessage(msg(text)))).toBe('INTERNAL')
    expect(site.opened).toEqual([])
  }, 60000)

  it('FR-OPS-2: on a dead session the tool answers SESSION_DEAD and opens nothing', async () => {
    state = 'dead'
    expect(await failure(tools().sendMessage(msg(REPLY)))).toBe('SESSION_DEAD')
    state = 'banned'
    expect(await failure(tools().sendMessage(msg(REPLY)))).toBe('BANNED')
    expect(site.opened).toEqual([])
  }, 60000)

  it('FR-ACC-6: when the tab may not move (a viewer on the live screen, a wrong IP) nothing is typed', async () => {
    may = false
    expect(await failure(tools().sendMessage(msg(REPLY)))).toBe('RATE_LIMITED')
    expect(site.presses).toEqual([])
    expect(site.opened).toEqual([])
  }, 60000)

  it('FR-CONV-9: a tab busy for longer than the queue wait is UNCERTAIN, and the call that gave up never types later', async () => {
    const held = await holdTab()
    expect(await failure(tools({ queueMs: 300 }).sendMessage(msg(REPLY)))).toBe('UNCERTAIN')
    held.release()
    await held.done
    await ins.inTab(async () => null)
    expect(site.presses).toEqual([])
    expect(site.opened).toEqual([])
  }, 60000)

  it('FR-CONV-9: once the core hangs up, a call still waiting for the tab never types', async () => {
    const held = await holdTab()
    const gone = new AbortController()
    const call = tools().sendMessage(msg(REPLY), gone.signal)
    await new Promise((r) => setTimeout(r, 100))
    gone.abort()
    held.release()
    await held.done
    expect(await failure(call)).toBe('RATE_LIMITED')
    expect(site.presses).toEqual([])
  }, 60000)

  it('FR-CONV-9: the box with the text typed is mapped once, never the text itself', async () => {
    const t = tools()
    await t.sendMessage(msg(REPLY))
    site.chats.set('c2', chat())
    await t.sendMessage(msg(`${REPLY} Ещё раз.`, { chat_id: 'c2' }))
    const maps = (await db.select().from(rawEvent)).filter(
      (r) => (r.body as { what?: string }).what === 'chat_form',
    )
    expect(maps).toHaveLength(1)
    expect(maps[0]?.body).toMatchObject({ typed: true, oldInput: 1, oldSend: 1 })
    expect(maps[0]?.url).toBe(`${FAKE_ORIGIN}/backoffice/r.php?id=0`)
    const all = JSON.stringify(maps[0])
    for (const secret of [REPLY, OURS, CLIENTS]) expect(all).not.toContain(secret)
  }, 60000)
})

describe('a key that was pressed is never refused as a plain failure', () => {
  /** The press written down, as after a node that died between the button and the answer. */
  const pressed = async (input: SendMessageInput) =>
    saveMessagePress(db, {
      key: input.idempotency_key,
      accountId: input.account_id,
      chatId: input.chat_id,
      expectLastMessageId: input.expect_last_message_id,
    })

  it('NFR-REL-4: a pressed key on a dead or banned session is UNCERTAIN, never SESSION_DEAD, and nothing is opened', async () => {
    const input = msg(REPLY)
    await pressed(input)
    // The message did go out before the session died.
    c1().messages.push({ id: '103', side: 'specialist', text: REPLY })
    for (const s of ['dead', 'banned'] as const) {
      state = s
      expect(await failure(tools().sendMessage(input))).toBe('UNCERTAIN')
    }
    expect(site.opened).toEqual([])
    expect(site.presses).toEqual([])
  }, 60000)

  it('NFR-REL-4: a pressed key with the node switch off is UNCERTAIN, never INTERNAL, and nothing is opened', async () => {
    const input = msg(REPLY)
    await pressed(input)
    expect(await failure(tools({ enabled: false }).sendMessage(input))).toBe('UNCERTAIN')
    expect(site.opened).toEqual([])
    expect(site.presses).toEqual([])
  }, 60000)

  it('NFR-REL-4: a stored result is still returned with the node switch off or the session dead (only a database read)', async () => {
    const input = msg(REPLY)
    const first = await tools().sendMessage(input)
    const opened = site.opened.length
    state = 'dead'
    expect(await tools({ enabled: false }).sendMessage(input)).toEqual(first)
    expect(site.opened).toHaveLength(opened)
  }, 60000)

  it('NFR-REL-4: a pressed key whose look cannot run (the tab busy past the wait) is UNCERTAIN', async () => {
    const input = msg(REPLY)
    await pressed(input)
    const held = await holdTab()
    expect(await failure(tools({ queueMs: 300 }).sendMessage(input))).toBe('UNCERTAIN')
    held.release()
    await held.done
    expect(site.opened).toEqual([])
  }, 60000)

  it('NFR-REL-4: a key stored for another account or chat never gets the stored answer', async () => {
    const input = msg(REPLY)
    await saveMessagePress(db, {
      key: input.idempotency_key,
      accountId: ACCOUNT,
      chatId: 'another-chat',
      expectLastMessageId: '102',
    })
    await db
      .update(messageAttempt)
      .set({ result: { found_on_page: true, platform_message_id: '9' } })
    expect(await failure(tools().sendMessage(input))).toBe('INTERNAL')
    expect(site.opened).toEqual([])
    expect(site.presses).toEqual([])
  }, 60000)
})
