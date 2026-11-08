import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { onClientText } from '../../src/conversation/commands'
import { ensureConversation, getConversation } from '../../src/conversation/store'
import {
  conversation as conversationTable,
  convTurn,
  event,
  lead,
  task,
  topicDiscussion,
} from '../../src/db/schema'
import type { ConverseOptions, ConverseResult } from '../../src/gateway/gateway'
import { createTurnKeys } from '../../src/secretary/mcp'
import { setSetting } from '../../src/settings/store'
import { createTopicChat, type TopicChat } from '../../src/topicChat/chat'
import { clearDiscussion, FOLDED } from '../../src/topicChat/discussion'
import type { TopicTurn } from '../../src/topicChat/tools'
import { fakeMind } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const ORDER = '95700001'
const ACC = 'hance-marketing'
let sent: { text: string; ref: number; rows?: unknown }[]
let deleted: number[]
let edited: { ref: number; text: string }[]
let marked: { ref: number; note: string }[]
let refuseDelete: boolean
let inputs: string[]
/** What the model does in a turn: the versions it proposes and the words it answers. */
let script: { propose?: string[]; answer: string; fail?: boolean }
let nextRef = 1000

const notifier = {
  sendText: async (text: string) => {
    const ref = -nextRef++
    sent.push({ text, ref })
    return { messageId: ref }
  },
  sendButtons: async (text: string, rows: unknown) => {
    const ref = -nextRef++
    sent.push({ text, ref, rows })
    return { messageId: ref }
  },
  markDone: async (ref: number, note: string) => {
    marked.push({ ref, note })
  },
  deletePost: async (ref: number) => {
    if (refuseDelete) return false
    deleted.push(ref)
    return true
  },
  editText: async (ref: number, text: string) => {
    edited.push({ ref, text })
  },
}
const keys = createTurnKeys<TopicTurn>()
let chat: TopicChat
let convId: string

/** The model as the CLI would be: it finds its turn by the key in the MCP config and calls `propose`. */
const converse = async (
  _role: string,
  input: string,
  o: ConverseOptions,
): Promise<ConverseResult> => {
  inputs.push(input)
  const cfg = JSON.parse(await readFile(o.mcp.configPath, 'utf8')) as {
    mcpServers: Record<string, { headers: { Authorization: string } }>
  }
  const key = Object.values(cfg.mcpServers)[0]?.headers.Authorization.replace('Bearer ', '') ?? ''
  const t = keys.find(key)
  if (!t) throw new Error('no turn')
  for (const p of script.propose ?? []) await chat.propose(t, p)
  if (script.fail)
    return {
      ok: false,
      errorClass: 'limit_reached',
      message: 'limit',
      durationMs: 1,
      modelCallId: 'm',
      resetAt: null,
    }
  return { ok: true, text: script.answer, durationMs: 1, modelCallId: 'm' }
}

const commandDeps = () => ({
  db,
  notifier: { sendText: notifier.sendText, closeTopic: async () => {} },
  sendText: async () => 'Отправляю',
  topicChat: chat,
})

beforeEach(async () => {
  await resetDb(db)
  sent = []
  deleted = []
  edited = []
  marked = []
  inputs = []
  refuseDelete = false
  script = { answer: 'Готово' }
  await setSetting(db, 'pipeline.conversations', true, 'system')
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await db.insert(lead).values({
    id: ORDER,
    accountId: ACC,
    title: 'Сайт для клиники',
    category: 'Маркетинг',
    city: 'Москва',
    text: 'Нужен сайт с записью',
    clientName: 'Анна',
    bidPriceRub: 290,
    seenAt: new Date().toISOString(),
    correlationId: newEventId(),
    status: 'bid_sent',
  })
  const conv = await ensureConversation(db, { accountId: ACC, chatId: ORDER, orderId: ORDER })
  convId = conv.id
  chat = createTopicChat({
    db,
    converse: converse as never,
    notifier,
    commands: commandDeps as never,
    mind: fakeMind(),
    keys,
    mcpUrl: () => 'http://127.0.0.1:1/mcp',
    dataDir: await mkdtemp(join(tmpdir(), 'topic-chat-')),
    publicUrl: 'https://sara.test',
  })
})

/** Sara's open draft card for the client, as a turn leaves it. */
async function draftCard(text: string) {
  const taskId = newEventId()
  await db.insert(convTurn).values({
    id: `turn-${taskId}`,
    conversationId: convId,
    kind: 'reply',
    anchorMessageId: 'm1',
    state: 'decided',
    text,
    decision: 'reply',
    taskId,
  })
  await db.insert(task).values({
    id: taskId,
    kind: 'conv_draft',
    entityKind: 'conv_turn',
    entityId: `turn-${taskId}`,
    priority: 'P1',
  })
  return taskId
}

const words = (text: string, ref: number, voice = false) =>
  onClientText(commandDeps() as never, {
    conversationId: convId,
    text,
    voice,
    messageId: ref,
    at: new Date(),
  })

describe('the chat in a client topic', () => {
  it('FR-NOTIF-4: his words rewrite the draft: the model reads the draft and his words, the version comes with «Отправить», nothing goes to the client', async () => {
    await draftCard('Добрый день! Стоимость от 80 000 ₽.')
    script = { propose: ['Добрый день! Давайте обсудим на созвоне в четверг.'], answer: 'Готово' }
    expect(await words('без цены, предложи созвон в четверг', -1)).toBeNull()
    await chat.idle()
    expect(inputs[0]).toContain('Добрый день! Стоимость от 80 000 ₽.')
    expect(inputs[0]).toContain('без цены, предложи созвон в четверг')
    const version = sent.find((s) => s.rows)
    expect(version?.text).toContain('Давайте обсудим на созвоне в четверг')
    expect(JSON.stringify(version?.rows)).toContain(':send')
    // «Готово» after a version is not posted.
    expect(sent).toHaveLength(1)
    const rows = await db.select().from(topicDiscussion)
    expect(rows.map((r) => r.kind).sort()).toEqual(['boris', 'version'])
  })

  it('FR-NOTIF-4: a newer version takes the buttons of the older one, and the next turn reads the talk so far', async () => {
    script = { propose: ['Вариант один'], answer: 'Готово' }
    await words('напиши ей про сроки', -1)
    await chat.idle()
    script = { propose: ['Вариант два'], answer: 'Готово' }
    await words('короче', -2)
    await chat.idle()
    const versions = sent.filter((s) => s.rows)
    expect(versions).toHaveLength(2)
    expect(marked).toEqual([{ ref: versions[0]?.ref ?? 0, note: 'Есть вариант новее' }])
    expect(inputs[1]).toContain('[Борис,')
    expect(inputs[1]).toContain('напиши ей про сроки')
    expect(inputs[1]).toContain('Вариант один')
    const open = await db.select().from(task).where(eq(task.kind, 'conv_say'))
    expect(open.filter((t) => t.state === 'open')).toHaveLength(1)
  })

  it('FR-NOTIF-4: a voice gets its transcript as a folded quote, kept with the discussion', async () => {
    script = { answer: 'Какой четверг, этот или следующий?' }
    await words('предложи четверг', -5, true)
    await chat.idle()
    expect(sent[0]?.text).toBe('<blockquote expandable>🎙 предложи четверг</blockquote>')
    expect(sent[1]?.text).toBe('Какой четверг, этот или следующий?')
    const kinds = (await db.select().from(topicDiscussion)).map((r) => r.kind).sort()
    expect(kinds).toEqual(['boris', 'sara', 'transcript'])
  })

  it('FR-NOTIF-4: commands stay commands: «беру сам» and «напиши: …» do not go to the chat, a bare «ответь ей» does', async () => {
    expect(await words('беру сам', -1)).toBeTruthy()
    await db.update(conversationTable).set({ owner: 'sara' })
    expect(await words('напиши: Добрый день, завтра пришлю КП', -2)).toBeTruthy()
    await chat.idle()
    expect(inputs).toHaveLength(0)
    expect(await words('ответь ей', -3)).toBeNull()
    await chat.idle()
    expect(inputs).toHaveLength(1)
  })

  it('FR-NOTIF-4: a Claude limit is said in the topic, the draft is untouched', async () => {
    await draftCard('Черновик')
    script = { answer: '', fail: true }
    await words('поправь', -1)
    await chat.idle()
    expect(sent.at(-1)?.text).toContain('лимит Claude')
    expect(sent.some((s) => s.rows)).toBe(false)
  })
})

describe('clearing the discussion after the send', () => {
  it('FR-NOTIF-4: every post of the discussion is deleted, the open version closed, the journal keeps only numbers', async () => {
    script = { propose: ['Вариант'], answer: 'Готово' }
    await words('сделай мягче', -1)
    await chat.idle()
    const r = await clearDiscussion({ db, notifier }, convId)
    expect(r.deleted.sort()).toEqual([-1, sent[0]?.ref ?? 0].sort())
    expect(deleted).toHaveLength(2)
    const rows = await db.select().from(topicDiscussion)
    expect(rows.every((x) => x.clearedAt && x.text === null)).toBe(true)
    const open = await db.select().from(task).where(eq(task.kind, 'conv_say'))
    expect(open.every((t) => t.state === 'resolved')).toBe(true)
    const [e] = await db.select().from(event).where(eq(event.type, 'topic.discussion_cleared'))
    expect(JSON.stringify(e?.payload)).not.toContain('мягче')
    // Nothing is cleared twice.
    expect((await clearDiscussion({ db, notifier }, convId)).deleted).toEqual([])
  })

  it('FR-NOTIF-4: a refusal folds the bot’s posts to one line and leaves Boris’s own', async () => {
    script = { answer: 'Уточни, пожалуйста' }
    await words('сделай мягче', -1)
    await chat.idle()
    refuseDelete = true
    const r = await clearDiscussion({ db, notifier }, convId)
    expect(r.kept).toEqual([-1])
    expect(r.folded).toEqual([sent[0]?.ref])
    expect(edited).toEqual([{ ref: sent[0]?.ref ?? 0, text: FOLDED }])
  })

  it('FR-NOTIF-4: posts older than 47 hours are folded without asking Telegram to delete', async () => {
    script = { answer: 'Ок' }
    await words('сделай мягче', -1)
    await chat.idle()
    const old = new Date(Date.now() - 50 * 3_600_000).toISOString()
    await db.update(topicDiscussion).set({ createdAt: old })
    const r = await clearDiscussion({ db, notifier }, convId)
    expect(deleted).toEqual([])
    expect(r.kept).toEqual([-1])
    expect(r.folded).toHaveLength(1)
  })

  it('FR-NOTIF-4: «remember» keeps his standing word in the conversation after the clearing', async () => {
    const { TOPIC_TOOLS } = await import('../../src/topicChat/tools')
    const t = {
      conversationId: convId,
      accountId: ACC,
      orderId: ORDER,
      redactor: { hide: (s: string) => s, tags: new Map() } as never,
      used: [],
      proposed: 0,
    }
    await TOPIC_TOOLS.remember.run({ db, mind: fakeMind(), propose: chat.propose }, t, {
      instruction: 'цену в чате не называем',
    })
    await clearDiscussion({ db, notifier }, convId)
    expect((await getConversation(db, convId))?.borisNote).toContain('цену в чате не называем')
  })
})
