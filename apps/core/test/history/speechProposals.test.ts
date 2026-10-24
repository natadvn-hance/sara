import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type ChatAuthor, newEventId } from '@sara/shared'
import { asc } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { checkMind } from '../../../../scripts/mind-check'
import { chatMessage, lead, mindIndex, mindProposal } from '../../src/db/schema'
import { proposeSpeechExamples } from '../../src/history/speechProposals'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const ACCOUNT = 'hance-marketing'
let n = 0
const at = (m: number) =>
  new Date(Date.parse('2026-10-01T10:00:00.000Z') + m * 60_000).toISOString()

async function msg(
  chat: string,
  author: ChatAuthor,
  text: string,
  o: { id?: string; order?: string | null } = {},
) {
  n++
  const side = author === 'client' || author === 'system' ? author : 'specialist'
  await db.insert(chatMessage).values({
    id: newEventId(),
    accountId: ACCOUNT,
    chatId: chat,
    orderId: o.order === undefined ? chat : o.order,
    platformMessageId: o.id ?? `p-${n}`,
    side,
    author,
    authorBasis:
      author === 'boris' ? 'v1_boris_text' : side === 'specialist' ? 'v1_or_boris' : 'side',
    text,
    sentAt: at(n),
    source: 'node',
  })
}

const proposals = () => db.select().from(mindProposal).orderBy(asc(mindProposal.path))

async function addLead(id: string, clientName: string) {
  await db.insert(lead).values({
    id,
    accountId: ACCOUNT,
    title: 'Сайт',
    category: 'Сайты',
    city: 'Москва',
    text: 'Нужен сайт',
    clientName,
    bidPriceRub: 300,
    seenAt: at(0),
    correlationId: newEventId(),
  })
}

describe('speech examples from history', () => {
  it("FR-SPEECH-2: an example holds the client's turn and Boris's answer", async () => {
    await msg('9001', 'sara_v1', 'Здравствуйте! Сделаем сайт.')
    await msg('9001', 'client', 'Добрый день.')
    await msg('9001', 'system', 'Клиент посмотрел ваш профиль')
    await msg('9001', 'client', 'А сколько по времени займёт?')
    await msg('9001', 'boris', 'Обычно месяц, если тексты будут готовы.', { id: 'b-77/x' })
    expect(await proposeSpeechExamples(db, { accountId: ACCOUNT })).toEqual({
      proposed: 1,
      skipped: 0,
    })
    const [p] = await proposals()
    expect(p).toMatchObject({
      path: 'mind/proposals/shared/speech/examples/e-h-b77x.md',
      kind: 'example',
      source: `history:${ACCOUNT}:b-77/x`,
      state: 'new',
    })
    const body = p?.content.split('\n---\n')[1] ?? ''
    expect(body).toBe(
      '\n## Клиент\n\nДобрый день.\n\nА сколько по времени займёт?\n\n## Борис\n\nОбычно месяц, если тексты будут готовы.\n',
    )
    expect(p?.content).toMatch(
      /^---\nid: e-h-b77x\ntype: example\nscope: shared\nstatus: proposal\n/,
    )
    expect(p?.content).not.toMatch(/stages/)
  })

  it("FR-SPEECH-2: only Boris's messages become examples", async () => {
    await msg('9002', 'client', 'Можно подробнее про этапы работы?')
    await msg('9002', 'unknown', 'Конечно, сначала бриф, потом прототип и дизайн.')
    await msg('9002', 'sara_v1', 'Давайте созвонимся и всё обсудим подробно.')
    await msg('9002', 'boris', 'Хорошо')
    await msg('9002', 'boris', 'Пришлю пример брифа сегодня вечером.')
    expect(await proposeSpeechExamples(db, { accountId: ACCOUNT })).toEqual({
      proposed: 1,
      skipped: 1,
    })
    const rows = await proposals()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toContain('Пришлю пример брифа сегодня вечером.')
  })

  it('FR-SPEECH-2: Boris writing before the client ever did is the bid stage', async () => {
    await msg('9003', 'boris', 'Добрый день! Посмотрел ваш заказ, есть пара вопросов.')
    await proposeSpeechExamples(db, { accountId: ACCOUNT })
    const [p] = await proposals()
    expect(p?.content).toContain('stages:\n  - bid_sent\n')
    expect(p?.content).toContain('## Клиент\n\nКлиент ещё ничего не написал.\n')
  })

  it('NFR-PRIV-2: a speech example holds no client name, phone, e-mail or link', async () => {
    await addLead('9004', 'Ирина Соколова')
    await msg(
      '9004',
      'client',
      'Меня зовут Ирина Соколова, телефон +7 916 123-45-67, почта irina.s@example.ru',
    )
    await msg(
      '9004',
      'boris',
      'Ирина, добрый день! Пишите в телеграм @hance_boris или смотрите https://hance.ru/cases и hance.ru',
    )
    await msg('9005', 'client', 'Это Пётр, сайт у нас petr-site.ru')
    await msg('9005', 'boris', 'Пётр, спасибо, посмотрю ваш сайт сегодня.')
    await proposeSpeechExamples(db, {
      accountId: ACCOUNT,
      clientNames: new Map([['9005', 'Пётр']]),
    })
    const rows = await proposals()
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.content).not.toMatch(
        /Ирин|Соколов|Пётр|Петр|916|123-45|irina|example\.ru|@|https|hance\.ru|petr-site/,
      )
      expect(r.content).toContain('[имя 1]')
    }
  })

  it('FR-MIND-3: examples become proposals, never mind records', async () => {
    await msg('9006', 'client', 'Сколько стоит лендинг?')
    await msg('9006', 'boris', 'Зависит от задачи, давайте обсудим на созвоне.')
    await proposeSpeechExamples(db, { accountId: ACCOUNT })
    expect(await db.select().from(mindIndex)).toEqual([])
    const [p] = await proposals()
    expect(p?.path.startsWith('mind/proposals/')).toBe(true)
    expect(p?.content).toContain('\nstatus: proposal\n')
  })

  it('FR-MIND-3: a repeated run adds no proposals', async () => {
    await msg('9007', 'client', 'Сколько стоит лендинг?')
    await msg('9007', 'boris', 'Зависит от задачи, давайте обсудим на созвоне.')
    await proposeSpeechExamples(db, { accountId: ACCOUNT })
    expect(await proposeSpeechExamples(db, { accountId: ACCOUNT })).toEqual({
      proposed: 0,
      skipped: 1,
    })
    expect(await proposals()).toHaveLength(1)
  })

  it('FR-MIND-1: the proposal written as a file passes the mind check', async () => {
    await msg('9008', 'client', 'Сколько стоит лендинг?')
    await msg('9008', 'boris', 'Зависит от задачи: давайте обсудим на созвоне, «бриф» пришлю.')
    await msg('9008', 'boris', 'Ещё вопрос: есть ли у вас логотип?', { id: 'v1:9008:boris:1' })
    await proposeSpeechExamples(db, { accountId: ACCOUNT })
    const dir = await mkdtemp(join(tmpdir(), 'sara-mind-'))
    try {
      for (const p of await proposals()) {
        const file = join(dir, p.path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, p.content)
      }
      expect(await checkMind(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
