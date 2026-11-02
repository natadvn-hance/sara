import { formatCallback, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  findPromises,
  onlyTypos,
  onReplySamplePress,
  REPLY_DIGEST_TEXTS,
  replyDigest,
} from '../../src/conversation/replyDigest'
import { ensureConversation } from '../../src/conversation/store'
import type { Db } from '../../src/db/client'
import {
  chatMessage,
  convTurn,
  event,
  jobRun,
  lead,
  meeting,
  mindIndex,
  mindProposal,
  replyPick,
  task,
} from '../../src/db/schema'
import type { CallOptions, Gateway } from '../../src/gateway/gateway'
import { acceptProposals } from '../../src/mind/cli'
import { ensureMindIndex } from '../../src/mind/indexer'
import { parseRecord } from '../../src/mind/loader'
import { exportProposals } from '../../src/mind/proposals'
import { inboxView } from '../../src/pult/inbox'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'
import { git, tempMind } from '../helpers/mind'

const { db, close } = openTestDb()
afterAll(close)

/** 11:00 Moscow: the day's post is due. */
const NOW = new Date('2026-11-03T08:00:00Z')
const TOMORROW = new Date('2026-11-04T08:00:00Z')
const ago = (hours: number, from = NOW) => new Date(from.getTime() - hours * 3600_000).toISOString()

type Sent = {
  text: string
  rows: { text: string; callbackData: string }[][]
  o: { quiet?: boolean; place?: unknown; notice?: { kind?: string } } | undefined
}
let sent: Sent[]
let edits: { id: number; text: string; rows: Sent['rows'] | undefined }[]
let refuseSend: boolean
const notifier = {
  async sendButtons(text: string, rows: Sent['rows'], o?: Sent['o']) {
    if (refuseSend) throw new Error('telegram is down')
    sent.push({ text, rows, o })
    return { messageId: 700 + sent.length }
  },
  async editText(id: number, text: string, rows?: Sent['rows']) {
    edits.push({ id, text, rows })
  },
}

type Call = { role: string; input: string; opts?: CallOptions }
let calls: Call[]
/** The cheap call as the code sees it: every reply comes back with the one typo the tests make fixed. */
let answer: ((replies: { n: number; text: string }[]) => unknown) | 'limit'
const gateway: Pick<Gateway, 'call'> = {
  async call(role, input, schema, opts) {
    calls.push({ role, input, ...(opts && { opts }) })
    if (answer === 'limit')
      return { ok: false, errorClass: 'limit_reached', message: 'limit' } as never
    const asked = (JSON.parse(input) as { replies: { n: number; text: string }[] }).replies
    return { ok: true, output: schema.parse(answer(asked)) } as never
  },
}
const fixTypo = (replies: { n: number; text: string }[]) => ({
  replies: replies.map((r) => ({ n: r.n, text: r.text.replace('бксплатно', 'бесплатно') })),
})

const d = () => ({ db, notifier, gateway })

beforeEach(async () => {
  await resetDb(db)
  sent = []
  edits = []
  calls = []
  refuseSend = false
  answer = fixTypo
  await setSetting(db, 'digest.boris_replies', true, 'system')
})

let seq = 0

/** A made-up chat: the client's words, Sara's draft, and what followed it. */
async function pair(
  o: {
    client?: string
    draft?: string | null
    reply?: string | null
    author?: string
    basis?: string
    /** How old the reply is, in hours. */
    age?: number
    /** Sara's own message between the draft and the reply: her draft went out. */
    saraSent?: string
    name?: string | null
    chatId?: string
    orderId?: string
    understanding?: unknown
    db?: Db
    from?: Date
  } = {},
) {
  seq += 1
  const n = seq
  const chatId = o.chatId ?? `9500${String(n).padStart(4, '0')}`
  const orderId = o.orderId ?? chatId
  const age = o.age ?? 24
  const from = o.from ?? NOW
  if (o.name !== null)
    await db
      .insert(lead)
      .values({
        id: orderId,
        accountId: 'hance-marketing',
        title: 'Сайт',
        category: 'Сайты',
        city: 'Краснодар',
        text: 'Нужен сайт',
        clientName: o.name ?? 'Ирина',
        bidPriceRub: 100,
        seenAt: ago(age + 5, from),
        correlationId: newEventId(),
      })
      .onConflictDoNothing()
  const conv = await ensureConversation(db, { accountId: 'hance-marketing', chatId, orderId })
  const msg = (id: string, side: string, author: string, basis: string, text: string, at: string) =>
    db.insert(chatMessage).values({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId,
      orderId,
      platformMessageId: id,
      side,
      author,
      authorBasis: basis,
      text,
      sentAt: at,
      source: 'node',
      conversationId: conv.id,
    })
  const clientId = `c-${n}`
  await msg(
    clientId,
    'client',
    'client',
    'side',
    o.client ?? 'А цена то какая?',
    ago(age + 2, from),
  )
  const draft =
    o.draft === undefined ? 'Стоимость зависит от объема работ, обсудим на созвоне.' : o.draft
  await db.insert(convTurn).values({
    id: `t-${n}`,
    conversationId: conv.id,
    kind: 'reply',
    anchorMessageId: clientId,
    messageIds: [clientId],
    state: 'finished',
    text: draft,
    outcome: 'drafted',
    understanding: o.understanding ?? { topic: 'price', tone: 'doubt' },
    createdAt: ago(age + 1.5, from),
  })
  if (o.saraSent)
    await msg(`s-${n}`, 'specialist', 'sara', 'outbox', o.saraSent, ago(age + 1, from))
  if (o.reply !== null)
    await msg(
      `b-${n}`,
      'specialist',
      o.author ?? 'boris',
      o.basis ?? 'after_cutover',
      o.reply ?? `Сделаем за неделю, начнем с короткого разбора вашей задачи номер ${n}`,
      ago(age, from),
    )
  return { conv, n, turnId: `t-${n}`, chatId }
}

/** The task behind the pair's button, by the reply's place in the post. */
async function pickOf(turnId: string) {
  const [p] = await db.select().from(replyPick).where(eq(replyPick.turnId, turnId))
  if (!p) throw new Error(`no pick for ${turnId}`)
  return p
}

async function proposals() {
  return db.select().from(mindProposal)
}

describe('which replies of Boris get in', () => {
  it('FR-SPEECH-5: the setting is off by default: no post and no model call', async () => {
    await resetDb(db)
    await pair()
    expect(await replyDigest(d(), NOW)).toBe('off')
    expect(sent).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('FR-SPEECH-5: before the morning hour there is no post yet', async () => {
    await pair()
    expect(await replyDigest(d(), new Date('2026-11-03T05:00:00Z'))).toBe('not_yet')
    expect(calls).toHaveLength(0)
  })

  it('FR-SPEECH-5: a reply written instead of the draft gets in with the client and the draft', async () => {
    await pair({ client: 'Сколько стоит сайт?', reply: 'Такой сайт обойдется примерно как машина' })
    expect(await replyDigest(d(), NOW)).toBe('sent')
    expect(sent[0]?.text).toContain('Сколько стоит сайт?')
    expect(sent[0]?.text).toContain('Стоимость зависит от объема работ')
    expect(sent[0]?.text).toContain('Такой сайт обойдется примерно как машина')
  })

  it('FR-SPEECH-5: a reply written after the draft went out gets in too', async () => {
    await pair({
      saraSent: 'Стоимость зависит от объема работ.',
      reply: 'Дополню: начнем с разбора',
    })
    expect(await replyDigest(d(), NOW)).toBe('sent')
    expect(sent[0]?.text).toContain('Дополню: начнем с разбора')
  })

  it('FR-SPEECH-5: several messages of Boris in a row are one reply', async () => {
    const p = await pair({ reply: 'Первое мое сообщение клиенту' })
    await db.insert(chatMessage).values({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId: p.chatId,
      orderId: p.chatId,
      platformMessageId: `b2-${p.n}`,
      side: 'specialist',
      author: 'boris',
      authorBasis: 'after_cutover',
      text: 'И второе вдогонку)',
      sentAt: ago(23.9),
      source: 'node',
      conversationId: p.conv.id,
    })
    await replyDigest(d(), NOW)
    const pick = await pickOf(p.turnId)
    expect(pick.replyText).toBe('Первое мое сообщение клиенту\n\nИ второе вдогонку)')
  })

  it('FR-SPEECH-5: the most different come first, five at most, and a near copy of the draft stays out', async () => {
    const draft = 'Стоимость зависит от объема работ, обсудим на созвоне завтра.'
    await pair({ draft, reply: `${draft} Хорошо` })
    for (const reply of [
      'Первый ответ, совсем иной текст',
      'Второй ответ, снова другой текст',
      'Третий ответ, опять другие слова',
      'Четвертый ответ, еще другие слова',
      'Пятый ответ, другие слова вовсе',
      'Шестой ответ, другие слова совсем',
    ])
      await pair({ draft, reply })
    expect(await replyDigest(d(), NOW)).toBe('sent')
    expect(sent).toHaveLength(1)
    const picks = await db.select().from(replyPick).orderBy(replyPick.position)
    expect(picks).toHaveLength(5)
    const scores = picks.map((p) => p.similarity)
    expect(scores).toEqual([...scores].sort((a, b) => a - b))
    expect(sent[0]?.text).not.toContain('Хорошо')
    // Two buttons a pair, one row a pair.
    expect(sent[0]?.rows).toHaveLength(5)
    expect(sent[0]?.rows.every((r) => r.length === 2)).toBe(true)
  })

  it('FR-SPEECH-5: a reply close to the draft is no lesson, even with nothing else to show', async () => {
    const draft = 'Стоимость зависит от объема работ, обсудим на созвоне завтра.'
    await pair({ draft, reply: `${draft} Хорошо` })
    expect(await replyDigest(d(), NOW)).toBe('empty')
    expect(calls).toHaveLength(0)
  })

  it('FR-SPEECH-5: test orders stay out', async () => {
    await pair({ chatId: '99000000001' })
    expect(await replyDigest(d(), NOW)).toBe('empty')
    expect(calls).toHaveLength(0)
  })

  it('FR-SPEECH-5: old Sara and a message of unknown voice stay out', async () => {
    await pair({ author: 'sara_v1', basis: 'v1_bid' })
    await pair({ author: 'unknown', basis: 'v1_or_boris' })
    await pair({ author: 'boris', basis: 'v1_boris_text' })
    expect(await replyDigest(d(), NOW)).toBe('empty')
  })

  it('FR-SPEECH-5: Sara alone, a turn with no draft and a turn with no reply give nothing to show', async () => {
    await pair({ reply: null, saraSent: 'Стоимость зависит от объема работ.' })
    await pair({ draft: null })
    expect(await replyDigest(d(), NOW)).toBe('empty')
  })

  it('FR-SPEECH-5: a reply too short to teach anything stays out', async () => {
    await pair({ reply: 'Да, хорошо' })
    expect(await replyDigest(d(), NOW)).toBe('empty')
  })

  it('FR-SPEECH-5: a reply waits half a day, so the client has time to answer, and a week-old one is left', async () => {
    await pair({ age: 3 })
    await pair({ age: 24 * 8 })
    expect(await replyDigest(d(), NOW)).toBe('empty')
  })

  it('NFR-PRIV-2: without a client name to hide the pair is not shown', async () => {
    await pair({ name: null })
    await pair({ name: 'Клиент 3' })
    expect(await replyDigest(d(), NOW)).toBe('empty')
    expect(calls).toHaveLength(0)
  })

  it('FR-SPEECH-5: two turns over one client message show Boris once', async () => {
    const p = await pair()
    await db.insert(convTurn).values({
      id: `t-again-${p.n}`,
      conversationId: p.conv.id,
      kind: 'reply',
      anchorMessageId: `c-${p.n}`,
      messageIds: [`c-${p.n}`],
      state: 'finished',
      text: 'Другой черновик про другое совсем',
      outcome: 'drafted',
      createdAt: ago(25),
    })
    await replyDigest(d(), NOW)
    expect(await db.select().from(replyPick)).toHaveLength(1)
  })
})

describe('the post', () => {
  it('FR-SPEECH-5: one post a day, in the general topic, without a sound', async () => {
    await pair()
    expect(await replyDigest(d(), NOW)).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.o?.quiet).toBe(true)
    expect(sent[0]?.o?.place).toBe('general')
    // A digest is no reason to ring the phone.
    expect(sent[0]?.o?.notice?.kind).toBe('summary')
    await pair()
    expect(await replyDigest(d(), NOW)).toBe('already')
    expect(sent).toHaveLength(1)
  })

  it('FR-SPEECH-5: nothing new, no post and no model call, and the day stays free', async () => {
    expect(await replyDigest(d(), NOW)).toBe('empty')
    expect(sent).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(await db.select().from(jobRun)).toHaveLength(0)
  })

  it('FR-SPEECH-5: a pair shown once never comes again, pressed or not', async () => {
    await pair()
    expect(await replyDigest(d(), NOW)).toBe('sent')
    expect(await replyDigest(d(), TOMORROW)).toBe('empty')
    expect(sent).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('FR-SPEECH-5: the pairs that did not fit come the next day', async () => {
    for (let i = 0; i < 6; i++)
      await pair({ reply: `Ответ ${i} совсем непохожий на черновик Сары` })
    await replyDigest(d(), NOW)
    expect(await db.select().from(replyPick)).toHaveLength(5)
    expect(await replyDigest(d(), TOMORROW)).toBe('sent')
    expect(await db.select().from(replyPick)).toHaveLength(6)
  })

  it('NFR-PRIV-2: the post and the model see no name, phone, e-mail or link of the client', async () => {
    await pair({
      name: 'Ирина Волкова',
      client: 'Меня зовут Ирина, телефон +7 916 123-45-67, почта irina@example.ru',
      draft: 'Ирина, напишу на irina@example.ru',
      reply: 'Ирина, добрый день! Вот пример https://example.ru/case и мой телефон 8 916 765-43-21',
    })
    expect(await replyDigest(d(), NOW)).toBe('sent')
    for (const text of [sent[0]?.text ?? '', calls[0]?.input ?? '']) {
      expect(text).not.toMatch(/Ирин|Волков|916|irina@|example\.ru/)
    }
    expect(sent[0]?.text).toContain('[имя 1]')
    expect(calls[0]?.opts?.redact?.names).toEqual(expect.arrayContaining(['Ирина Волкова']))
    expect(calls[0]?.opts?.redact?.restore).toBe(false)
  })

  it('NFR-PRIV-2: a chat with no name on the board stays out, whatever word stands before the first comma', async () => {
    await pair({ name: null, reply: 'Ничем, если нужен просто сайт, начнем с разбора' })
    expect(await replyDigest(d(), NOW)).toBe('empty')
    expect(calls).toHaveLength(0)
  })

  it('NFR-PRIV-2: a word of Boris before the first comma is his word, not a name to hide', async () => {
    const p = await pair({ name: 'Анна', reply: 'Ничем, если нужен просто сайт, начнем с разбора' })
    expect(await replyDigest(d(), NOW)).toBe('sent')
    expect((await pickOf(p.turnId)).replyText).toBe(
      'Ничем, если нужен просто сайт, начнем с разбора',
    )
  })

  it('NFR-PRIV-2: the name from the order page is hidden too, not only the one on the board', async () => {
    const p = await pair({
      name: 'Ирина',
      client: 'Волкова беспокоит, Ирина',
      reply: 'Добрый день! Ответила бы Волковой так, начнем с разбора',
    })
    await db
      .update(lead)
      .set({ clientInfo: { name: 'Ирина Волкова' } })
      .where(eq(lead.id, p.chatId))
    expect(await replyDigest(d(), NOW)).toBe('sent')
    expect(sent[0]?.text).not.toMatch(/Ирин|Волков/)
    expect(calls[0]?.input).not.toMatch(/Ирин|Волков/)
  })

  it('NFR-PRIV-2: the journal keeps only numbers and references, no text of a chat', async () => {
    const p = await pair({ client: 'Секрет клиента в словах', reply: 'Секрет Бориса в его ответе' })
    await replyDigest(d(), NOW)
    const pick = await pickOf(p.turnId)
    await onReplySamplePress({ db, notifier }, pick.id, 'apply', NOW)
    const events = await db.select().from(event)
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['conv.replies_digest', 'conv.reply_sampled', 'mind.proposed']),
    )
    expect(JSON.stringify(events)).not.toMatch(/Секрет|Ирин/)
  })

  it('FR-SPEECH-5: the post never holds a long dash and fits a Telegram message', async () => {
    const long = 'Длинные слова клиента и еще слова '.repeat(40)
    for (let i = 0; i < 5; i++)
      await pair({
        client: long,
        draft: `Черновик Сары номер ${i} ${long}`,
        reply: `Ответ ${i} \u2014 ${'совсем другие длинные слова Бориса '.repeat(30)}`,
      })
    expect(await replyDigest(d(), NOW)).toBe('sent')
    expect(sent[0]?.text.length).toBeLessThanOrEqual(4096)
    expect(sent[0]?.text).not.toMatch(/[\u2014\u2013]/)
  })

  it('FR-SPEECH-5: the pairs wait in no inbox of the pult: the post is their one place', async () => {
    await pair()
    await replyDigest(d(), NOW)
    const view = await inboxView(db)
    expect(JSON.stringify(view)).not.toContain('reply_sample')
    const [t] = await db.select().from(task)
    expect(t?.kind).toBe('reply_sample')
    expect(t?.state).toBe('open')
  })
})

describe('the one cheap call', () => {
  it('FR-SPEECH-5: all the replies of the day go in one call of the cheap role', async () => {
    for (let i = 0; i < 3; i++) await pair({ reply: `Ответ ${i} совсем непохожий на черновик` })
    await replyDigest(d(), NOW)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.role).toBe('reply-cleaner')
  })

  it('FR-SPEECH-5: the role is the cheap model with no dearer fallback, and reads through the real gateway', async () => {
    const fake = await fakeGateway(db, {
      'reply-cleaner': {
        replies: [{ n: 1, text: 'Сделаем макет бесплатно, начнем на этой неделе' }],
      },
    })
    await pair({ reply: 'Сделаем макет бксплатно, начнем на этой неделе' })
    expect(await replyDigest({ db, notifier, gateway: fake.gateway }, NOW)).toBe('sent')
    const [call] = await fake.calls()
    expect(call?.role).toBe('reply-cleaner')
    expect(call?.model).toBe('haiku')
    const meta = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        `${fake.rolesDir}/reply-cleaner/meta.json`,
        'utf8',
      ),
    ) as { fallbackModel?: string; priority: string }
    expect(meta.fallbackModel).toBeUndefined()
    expect(meta.priority).toBe('P3')
  })

  it('FR-SPEECH-5: a typo of Boris is gone from the post and from what he saves', async () => {
    const p = await pair({ reply: 'Сделаем макет бксплатно, начнем на этой неделе' })
    await replyDigest(d(), NOW)
    expect(sent[0]?.text).toContain('Сделаем макет бесплатно')
    expect(sent[0]?.text).not.toContain('бксплатно')
    await onReplySamplePress({ db, notifier }, (await pickOf(p.turnId)).id, 'apply', NOW)
    const [saved] = await proposals()
    expect(saved?.content).toContain('Сделаем макет бесплатно')
    expect(saved?.content).not.toContain('бксплатно')
  })

  it('FR-SPEECH-5: an answer that rewrites Boris is not taken: the pair waits for another day', async () => {
    const p = await pair({ reply: 'Сделаем быстро, начнем прямо на этой неделе' })
    answer = (replies) => ({
      replies: replies.map((r) => ({
        n: r.n,
        text: 'Мы выполним проект в кратчайшие сроки, уважаемый клиент',
      })),
    })
    expect(await replyDigest(d(), NOW)).toBe('empty')
    expect(sent).toHaveLength(0)
    expect(await db.select().from(replyPick)).toHaveLength(0)
    answer = fixTypo
    expect(await replyDigest(d(), TOMORROW)).toBe('sent')
    expect((await pickOf(p.turnId)).replyText).toContain('Сделаем быстро')
  })

  it('FR-SPEECH-5: at the Claude limit no post and no second try that day, the next day it goes', async () => {
    await pair()
    answer = 'limit'
    expect(await replyDigest(d(), NOW)).toBe('no_model')
    expect(await replyDigest(d(), NOW)).toBe('already')
    expect(calls).toHaveLength(1)
    expect(sent).toHaveLength(0)
    answer = fixTypo
    expect(await replyDigest(d(), TOMORROW)).toBe('sent')
  })

  it('FR-SPEECH-5: a post Telegram refused leaves nothing waiting, no second call that day, and comes the next day', async () => {
    await pair()
    refuseSend = true
    await expect(replyDigest(d(), NOW)).rejects.toThrow('telegram is down')
    expect(await db.select().from(replyPick)).toHaveLength(0)
    expect(await db.select().from(task)).toHaveLength(0)
    expect(await replyDigest(d(), NOW)).toBe('already')
    expect(calls).toHaveLength(1)
    refuseSend = false
    expect(await replyDigest(d(), TOMORROW)).toBe('sent')
  })

  it('FR-SPEECH-5: only typos pass: tags kept, few letters changed', () => {
    expect(onlyTypos('Сделаем макет бксплатно', 'Сделаем макет бесплатно')).toBe(true)
    expect(onlyTypos('Привет', 'Привет')).toBe(true)
    expect(onlyTypos('[имя 1], добрый день', 'Добрый день')).toBe(false)
    expect(onlyTypos('Сделаем быстро и недорого', 'Выполним работу в короткий срок')).toBe(false)
    expect(onlyTypos('Вот пример [ссылка 1]', 'Вот пример [ссылка 2]')).toBe(false)
  })
})

describe('the buttons', () => {
  it('FR-SPEECH-5: every pair has «В образцы» and «Не надо» of its own task', async () => {
    const a = await pair({ reply: 'Первый ответ совсем другой текст' })
    const b = await pair({ reply: 'Второй ответ совсем другие слова' })
    await replyDigest(d(), NOW)
    const pa = await pickOf(a.turnId)
    const pb = await pickOf(b.turnId)
    const all = sent[0]?.rows.flat() ?? []
    for (const p of [pa, pb]) {
      const n = p.position + 1
      expect(all).toContainEqual({
        text: `${n}: ${REPLY_DIGEST_TEXTS.sampleButton}`,
        callbackData: formatCallback(p.id, 'apply'),
      })
      expect(all).toContainEqual({
        text: `${n}: ${REPLY_DIGEST_TEXTS.dropButton}`,
        callbackData: formatCallback(p.id, 'drop'),
      })
    }
  })

  it('FR-MIND-3: «В образцы» makes a proposal only: the file says proposal and lies in proposals', async () => {
    const p = await pair({
      client: 'Сколько стоит сайт?',
      reply: 'Обсудим задачу, потом назову сумму',
    })
    await replyDigest(d(), NOW)
    const answerText = await onReplySamplePress(
      { db, notifier },
      (await pickOf(p.turnId)).id,
      'apply',
      NOW,
    )
    expect(answerText).toBe(REPLY_DIGEST_TEXTS.sampled)
    const rows = await proposals()
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row?.state).toBe('new')
    expect(row?.kind).toBe('example')
    expect(row?.source).toBe(`live:${p.turnId}`)
    expect(row?.path).toMatch(/^mind\/proposals\/shared\/speech\/examples\/e-l-[0-9a-f]{12}\.md$/)
    // Read as the mind reads a record once it is accepted.
    const parsed = parseRecord(
      (row?.path ?? '').replace('mind/proposals/', 'mind/'),
      row?.content ?? '',
    )
    if ('error' in parsed) throw new Error(parsed.error)
    const { front, sections } = parsed.record
    expect(front.status).toBe('proposal')
    expect(front.type).toBe('example')
    expect(front.topic).toBe('price')
    expect(front.tones).toEqual(['doubt'])
    expect(front.stages).toEqual(['talking'])
    expect(front.sources.join(' ')).toContain('live:hance-marketing:b-')
    expect(front.sources.join(' ')).toContain('boris-press:2026-11-03')
    expect(sections.Клиент).toBe('Сколько стоит сайт?')
    expect(sections.Борис).toBe('Обсудим задачу, потом назову сумму')
  })

  it('FR-SPEECH-5: the saved record tells the real outcome: the client answered, the call was reached', async () => {
    const p = await pair({ reply: 'Обсудим задачу, потом назову сумму' })
    await replyDigest(d(), NOW)
    await db.insert(chatMessage).values({
      id: newEventId(),
      accountId: 'hance-marketing',
      chatId: p.chatId,
      orderId: p.chatId,
      platformMessageId: `after-${p.n}`,
      side: 'client',
      author: 'client',
      authorBasis: 'side',
      text: 'Давайте созвонимся',
      sentAt: ago(23),
      source: 'node',
      conversationId: p.conv.id,
    })
    await db.insert(meeting).values({
      id: newEventId(),
      conversationId: p.conv.id,
      title: 'Созвон',
      startsAt: ago(1),
    })
    await onReplySamplePress({ db, notifier }, (await pickOf(p.turnId)).id, 'apply', NOW)
    const [row] = await proposals()
    expect(row?.content).toContain('## Исход')
    expect(row?.content).toContain('клиент ответил через 1 ч')
    expect(row?.content).toContain('созвон назначен')
    expect(row?.content).not.toContain('Давайте созвонимся')
  })

  it('FR-SPEECH-5: a held call is told as held', async () => {
    const p = await pair({ reply: 'Обсудим задачу, потом назову сумму' })
    await replyDigest(d(), NOW)
    await db.insert(meeting).values({
      id: newEventId(),
      conversationId: p.conv.id,
      title: 'Созвон',
      startsAt: ago(1),
      outcome: 'held',
    })
    await onReplySamplePress({ db, notifier }, (await pickOf(p.turnId)).id, 'apply', NOW)
    expect((await proposals())[0]?.content).toContain('созвон состоялся')
  })

  it('FR-SPEECH-5: the record says so when the client kept quiet and no call came', async () => {
    const p = await pair({ reply: 'Обсудим задачу, потом назову сумму' })
    await replyDigest(d(), NOW)
    await onReplySamplePress({ db, notifier }, (await pickOf(p.turnId)).id, 'apply', NOW)
    const [row] = await proposals()
    expect(row?.content).toContain('клиент пока не ответил')
    expect(row?.content).toContain('созвона нет')
    expect(row?.content).toContain('На 03.11.2026')
  })

  it('NFR-PRIV-2: the saved record holds tags in place of the client data', async () => {
    const p = await pair({
      name: 'Ирина Волкова',
      client: 'Ирина Волкова, +7 916 123-45-67, irina@example.ru',
      reply: 'Ирина, добрый день! Пример: https://example.ru/case',
    })
    await replyDigest(d(), NOW)
    await onReplySamplePress({ db, notifier }, (await pickOf(p.turnId)).id, 'apply', NOW)
    const [row] = await proposals()
    expect(row?.content).not.toMatch(/Ирин|Волков|916|irina@|example\.ru/)
    expect(row?.content).toContain('[имя 1]')
    expect(row?.content).toContain('[ссылка 1]')
    expect(row?.content).not.toContain(p.chatId)
  })

  it('FR-SPEECH-5: «Не надо» makes no proposal and the pair is not shown again', async () => {
    const p = await pair()
    await replyDigest(d(), NOW)
    const pick = await pickOf(p.turnId)
    expect(await onReplySamplePress({ db, notifier }, pick.id, 'drop', NOW)).toBe(
      REPLY_DIGEST_TEXTS.dropped,
    )
    expect(await proposals()).toHaveLength(0)
    expect((await pickOf(p.turnId)).decision).toBe('drop')
    expect(await replyDigest(d(), TOMORROW)).toBe('empty')
  })

  it('FR-MIND-3: a proposal the old way made of the same words gives way to his decision', async () => {
    const p = await pair()
    const raw = {
      path: `mind/proposals/shared/speech/examples/e-b-${p.n}.md`,
      content: 'сырой текст',
      kind: 'example',
      source: `boris:${p.turnId}`,
    }
    await db.insert(mindProposal).values({ id: newEventId(), ...raw })
    await replyDigest(d(), NOW)
    await onReplySamplePress({ db, notifier }, (await pickOf(p.turnId)).id, 'apply', NOW)
    const rows = await proposals()
    expect(rows.find((r) => r.source === raw.source)?.state).toBe('rejected')
    expect(rows.find((r) => r.source === `live:${p.turnId}`)?.state).toBe('new')
  })

  it('FR-SPEECH-5: a second press changes nothing', async () => {
    const p = await pair()
    await replyDigest(d(), NOW)
    const pick = await pickOf(p.turnId)
    await onReplySamplePress({ db, notifier }, pick.id, 'apply', NOW)
    expect(await onReplySamplePress({ db, notifier }, pick.id, 'drop', NOW)).toBe(
      REPLY_DIGEST_TEXTS.alreadyDone,
    )
    expect(await proposals()).toHaveLength(1)
    expect((await pickOf(p.turnId)).decision).toBe('apply')
    expect(edits).toHaveLength(1)
  })

  it("FR-SPEECH-5: a press takes away only that pair's buttons and marks it in the post", async () => {
    const a = await pair({ reply: 'Первый ответ совсем другой текст' })
    const b = await pair({ reply: 'Второй ответ совсем другие слова' })
    await replyDigest(d(), NOW)
    const pa = await pickOf(a.turnId)
    const pb = await pickOf(b.turnId)
    await onReplySamplePress({ db, notifier }, pa.id, 'apply', NOW)
    const [edit] = edits
    expect(edit?.id).toBe(701)
    expect(edit?.text).toContain(REPLY_DIGEST_TEXTS.markSampled)
    expect(edit?.rows?.flat().map((x) => x.callbackData)).toEqual([
      formatCallback(pb.id, 'apply'),
      formatCallback(pb.id, 'drop'),
    ])
    await onReplySamplePress({ db, notifier }, pb.id, 'drop', NOW)
    expect(edits[1]?.text).toContain(REPLY_DIGEST_TEXTS.markDropped)
    expect(edits[1]?.rows).toEqual([])
  })

  it('FR-SPEECH-5: a post Telegram will not edit does not undo the press', async () => {
    const p = await pair()
    await replyDigest(d(), NOW)
    const broken = {
      ...notifier,
      editText: async () => {
        throw new Error('message to edit not found')
      },
    }
    expect(
      await onReplySamplePress({ db, notifier: broken }, (await pickOf(p.turnId)).id, 'apply', NOW),
    ).toBe(REPLY_DIGEST_TEXTS.sampled)
    expect(await proposals()).toHaveLength(1)
  })
})

describe('commercial promises', () => {
  it('FR-SPEECH-5: a promise of Boris is found, plain words are not', () => {
    expect(findPromises('Сделаем макет бесплатно')).toEqual(['бесплатно'])
    expect(findPromises('Дам скидку 10%, если начнем сейчас')).toEqual(['скидку'])
    expect(findPromises('Гарантируем результат')).toEqual(['гарантируем'])
    expect(findPromises('Вернем деньги, если не понравится')).toEqual(['вернем деньги'])
    expect(findPromises('В подарок настроим аналитику')).toEqual(['в подарок'])
    expect(findPromises('Обойдется в 20 000 рублей')).toEqual(['20 000 рублей'])
    expect(findPromises('Сделаем за 3 дня')).toEqual(['за 3 дня'])
    expect(findPromises('Сделаем быстро и качественно, давайте созвонимся')).toEqual([])
    expect(findPromises('У меня 5 лет опыта и 20 проектов')).toEqual([])
  })

  it('FR-SPEECH-5: the post marks a promise and so does the saved record', async () => {
    const p = await pair({ reply: 'Сделаем макет бесплатно, начнем на этой неделе' })
    await replyDigest(d(), NOW)
    expect(sent[0]?.text).toContain('Обещание: бесплатно')
    await onReplySamplePress({ db, notifier }, (await pickOf(p.turnId)).id, 'apply', NOW)
    const [row] = await proposals()
    const parsed = parseRecord(
      (row?.path ?? '').replace('mind/proposals/', 'mind/'),
      row?.content ?? '',
    )
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.record.sections.Обещание).toContain('бесплатно')
    expect(parsed.record.sections.Обещание).toContain('Сара сама такое не предлагает')
    // His words stay as he wrote them: the mark is beside them.
    expect(parsed.record.sections.Борис).toBe('Сделаем макет бесплатно, начнем на этой неделе')
  })

  it('FR-SPEECH-5: a reply without a promise has no such mark', async () => {
    const p = await pair({ reply: 'Обсудим задачу, потом назову сумму' })
    await replyDigest(d(), NOW)
    expect(sent[0]?.text).not.toContain('Обещание')
    await onReplySamplePress({ db, notifier }, (await pickOf(p.turnId)).id, 'apply', NOW)
    expect((await proposals())[0]?.content).not.toContain('## Обещание')
  })
})

describe('the way into the mind', () => {
  async function clone(): Promise<string> {
    const dir = await tempMind()
    await git(dir, 'init', '-q')
    await git(dir, 'config', 'user.email', 'test@example.com')
    await git(dir, 'config', 'user.name', 'test')
    return dir
  }

  it('FR-MIND-3: nothing reaches the index by the press; only `mind accept` confirms, and Sara then reads the promise mark', async () => {
    const p = await pair({
      client: 'А макет?',
      reply: 'Сделаем макет бесплатно, начнем на этой неделе',
    })
    await replyDigest(d(), NOW)
    // Pressed today by the real clock: the index takes a record valid from today or earlier.
    await onReplySamplePress({ db, notifier }, (await pickOf(p.turnId)).id, 'apply')
    expect(await db.select().from(mindIndex)).toHaveLength(0)

    const dir = await clone()
    expect(await exportProposals(db, dir)).toBe(1)
    const [row] = await proposals()
    await ensureMindIndex(db, dir)
    expect(await db.select().from(mindIndex)).toHaveLength(0)

    const [accepted] = await acceptProposals(dir, [row?.path ?? ''])
    expect(accepted?.to).toMatch(/^mind\/shared\/speech\/examples\/e-l-/)
    await ensureMindIndex(db, dir)
    const [indexed] = await db.select().from(mindIndex)
    expect(indexed?.exampleClient).toBe('А макет?')
    expect(indexed?.exampleBoris).toContain('Сделаем макет бесплатно')
    expect(indexed?.exampleBoris).toContain('Сара сама такое не предлагает')
  })
})
