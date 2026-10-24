import { eq, isNotNull } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeTelegram, type FakeTelegram } from '../../../tests/fakes/telegramApi'
import { leadLabel, question } from '../src/db/schema'
import { seedDirection } from '../src/direction/store'
import { handleBorisMessage } from '../src/learning/inbox'
import { recordLabel } from '../src/learning/labels'
import { askForDraft, askWhy, type DraftAnswer } from '../src/learning/questions'
import { createTelegramRuntime, type TelegramRuntime } from '../src/notify/telegram'
import { openTestDb, resetDb } from './helpers/db'
import { countEvents } from './helpers/events'
import { leadWithScore } from './helpers/learning'

const { db, close } = openTestDb()
afterAll(close)

let tg: FakeTelegram
let bot: TelegramRuntime
let heard: string | null = 'бюджет копейки'
const transcribe = vi.fn(async () => heard)
const onDraftText = vi.fn(async (_a: DraftAnswer) => 'Записала новый текст отклика')
const onMessage = vi.fn((m: Parameters<typeof handleBorisMessage>[1]) =>
  handleBorisMessage({ db, transcriber: { transcribe }, onDraftText }, m),
)

async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}
const said = (t: string) => tg.sent.some((m) => m.text === t)

/** Boris is bound, and Sara asked why he skipped lead 920001. Returns the question's message id. */
async function asked(): Promise<number> {
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await leadWithScore(db, '920001', 80)
  await recordLabel(db, { leadId: '920001', label: 'no', source: 'card' })
  await askWhy(
    { db, notifier: bot.notifier },
    { kind: 'why_skip', entityId: '920001', title: 'Реклама на ТВ' },
    new Date(),
  )
  const [q] = await db.select().from(question)
  return q?.telegramMessageId ?? -1
}
const label = async () =>
  (await db.select().from(leadLabel).where(eq(leadLabel.leadId, '920001')))[0]

beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  heard = 'бюджет копейки'
  transcribe.mockClear()
  onMessage.mockClear()
  onDraftText.mockClear()
  tg = await createFakeTelegram()
  bot = createTelegramRuntime({
    token: tg.token,
    apiRoot: tg.apiRoot,
    db,
    onPress: async () => 'ok',
    onMessage,
  })
  await bot.start()
})
afterEach(async () => {
  await bot.stop()
  await tg.close()
})

describe("Boris's words in the bot", () => {
  it("FR-LEAD-7: Boris's reply text to a question is noted", async () => {
    const q = await asked()
    tg.pushText(111, 'не наш профиль', q)
    await until(() => said('Записала по «Реклама на ТВ»: «не наш профиль»'))
    expect(await label()).toMatchObject({ reason: 'не наш профиль', voice: false })
  })

  it('FR-LEAD-7: a voice answer is recognized and noted, marked as voice', async () => {
    const q = await asked()
    tg.pushVoice(111, q)
    await until(() => said('Записала по «Реклама на ТВ»: «бюджет копейки»'))
    expect(transcribe).toHaveBeenCalledOnce()
    expect(await label()).toMatchObject({ reason: 'бюджет копейки', voice: true })
  })

  it('FR-LEAD-7: a voice reply to the edit request goes to the draft, not to a reason', async () => {
    const q = await asked()
    const taskId = '0192f3c4-5b6a-7c8d-9e0f-aabbccdd0001'
    await askForDraft(
      { db, notifier: bot.notifier },
      { taskId, title: 'Реклама на ТВ' },
      new Date(),
    )
    const [edit] = await db.select().from(question).where(eq(question.kind, 'edit_draft'))
    tg.pushVoice(111, edit?.telegramMessageId ?? -1)
    await until(() => said('Записала новый текст отклика'))
    expect(onDraftText).toHaveBeenCalledOnce()
    expect(onDraftText.mock.calls[0]?.[0]).toMatchObject({
      question: { kind: 'edit_draft', entityId: taskId },
      text: 'бюджет копейки',
      voice: true,
    })
    expect((await label())?.reason).toBeNull()
    // The «почему?» asked before is still open for its own answer.
    tg.pushText(111, 'не наш профиль', q)
    await until(() => said('Записала по «Реклама на ТВ»: «не наш профиль»'))
  })

  it('FR-LEAD-7: a plain text while an edit request and a «почему?» both wait is asked about, not stored', async () => {
    await asked()
    const taskId = await leadWithScore(db, '920002', 80)
    await askForDraft({ db, notifier: bot.notifier }, { taskId, title: 'Сайт клиники' }, new Date())
    tg.pushText(111, 'новый текст отклика')
    await until(() => tg.sent.some((m) => m.text.startsWith('Не поняла')))
    expect(tg.sent.at(-1)?.text).toBe(
      'Не поняла, к какому моему вопросу это. Сейчас жду:\n- почему пропустил «Реклама на ТВ»\n- новый текст отклика на «Реклама на ТВ»\nНажми «Ответить» на нужном моём сообщении и пришли текст ещё раз.',
    )
    expect(onDraftText).not.toHaveBeenCalled()
    expect((await label())?.reason).toBeNull()
    expect(await db.select().from(question).where(isNotNull(question.answeredAt))).toHaveLength(0)
  })

  it('FR-NOTIF-1: two edit requests for the same lead are listed once when Sara asks which question a text answers', async () => {
    await asked()
    const taskId = await leadWithScore(db, '920003', 80)
    const edit = { db, notifier: bot.notifier }
    await askForDraft(edit, { taskId, title: 'Сайт клиники' }, new Date())
    await askForDraft(edit, { taskId, title: 'Сайт клиники' }, new Date())
    tg.pushText(111, 'новый текст отклика')
    await until(() => tg.sent.some((m) => m.text.startsWith('Не поняла')))
    expect(
      tg.sent
        .at(-1)
        ?.text.split('\n')
        .filter((l) => l.startsWith('- ')),
    ).toHaveLength(2)
  })

  it('NFR-UX-1: a long dash in the recognized voice comes back to Boris as a hyphen', async () => {
    const q = await asked()
    heard = `бюджет ${String.fromCharCode(0x2014)} копейки`
    tg.pushVoice(111, q)
    await until(() => tg.sent.some((m) => m.text.startsWith('Записала по')))
    expect(tg.sent.at(-1)?.text).toBe('Записала по «Реклама на ТВ»: «бюджет - копейки»')
  })

  it('FR-LEAD-7: an unrecognized voice asks for text and notes nothing', async () => {
    const q = await asked()
    heard = null
    tg.pushVoice(111, q)
    await until(() => said('Не смогла разобрать голосовое, напиши текстом, пожалуйста'))
    expect((await label())?.reason).toBeNull()
  })

  it('FR-LEAD-7: a message that answers nothing gets «Пока я понимаю только ответы на мои вопросы»', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    tg.pushText(111, 'привет')
    await until(() => said('Пока я понимаю только ответы на мои вопросы'))
  })

  it('NFR-SEC-1: text and voice from a foreign chat are ignored and logged', async () => {
    tg.pushStart(111)
    await until(() => tg.sent.length === 1)
    tg.pushText(222, 'чужой')
    tg.pushVoice(222)
    await until(async () => (await countEvents(db, 'security.foreign_chat')) === 2)
    expect(onMessage).not.toHaveBeenCalled()
    expect(tg.sent).toHaveLength(1)
  })

  it('FR-LEAD-7: a voice that cannot be downloaded gets «Не смогла разобрать голосовое»', async () => {
    const q = await asked()
    tg.setFileBroken(true)
    tg.pushVoice(111, q)
    await until(() => said('Не смогла разобрать голосовое, напиши текстом, пожалуйста'))
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('FR-LEAD-7: while a voice is being recognized, button presses are still answered', async () => {
    const q = await asked()
    let release: () => void = () => {}
    transcribe.mockImplementationOnce(
      () =>
        new Promise<string | null>((r) => {
          release = () => r('бюджет копейки')
        }),
    )
    tg.pushVoice(111, q)
    await until(() => transcribe.mock.calls.length === 1)
    tg.pushPress(111, 't:0192f3c4-5b6a-7c8d-9e0f-112233445566:skip')
    await until(() => tg.answers.length === 1)
    expect(said('Записала по «Реклама на ТВ»: «бюджет копейки»')).toBe(false)
    release()
    await until(() => said('Записала по «Реклама на ТВ»: «бюджет копейки»'))
  })
})
