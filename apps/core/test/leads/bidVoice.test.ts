import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BID_VOICE_SAMPLES,
  type BidVoice,
  bannedIn,
  bidVoiceFor,
  bidVoiceText,
} from '../../src/leads/bidVoice'
import { ensureMindIndex } from '../../src/mind/indexer'
import { createMindSearch } from '../../src/mind/search'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'
import { putRecord, tempMind } from '../helpers/mind'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const mind = createMindSearch(db)
const REAL = '95812257'
const TEST = '99000000001'
const DASH = String.fromCharCode(0x2014)

/**
 * The voice as the mind holds it (sara-mind #11): the shared form of the text, the trial portrait, rule and samples.
 * Invented texts only; the samples are two of the first touch and one of a chat in full swing.
 */
async function voiceMind(): Promise<void> {
  const root = await tempMind()
  await putRecord(
    root,
    'mind/shared/judgment/tone.md',
    { id: 'j-tone', type: 'judgment', title: 'Тон и форма текста', tags: ['тон'] },
    '## Правило: форма текста\nВ конце абзаца точку не ставим.',
  )
  await putRecord(
    root,
    'mind/directions/trial/speech/portrait.md',
    { id: 's-portrait', type: 'speech', scope: 'trial', title: 'Портрет речи Бориса' },
    '## Режим: строже или свободнее\nСтроже: первое касание.\n\n## Никогда не говорит\n- По опыту\n- Как вам такое',
  )
  await putRecord(
    root,
    'mind/directions/trial/judgment/voice.md',
    { id: 'j-voice', type: 'judgment', scope: 'trial', title: 'Голос Бориса', tags: ['голос'] },
    '## Правило: кавычки\nБез ёлочек.',
  )
  await putRecord(
    root,
    'mind/directions/trial/speech/examples/e-boris-52.md',
    { id: 'e-boris-52', type: 'example', scope: 'trial', title: 'Напоминание', topic: 'process' },
    '## Клиент\n\n(Обещал посмотреть разбор и пропал)\n\n## Борис\n\nДобрый день, [имя 1]!\nПишу насчет разбора\n\n## Контекст\n\nСтрогий режим.',
  )
  await putRecord(
    root,
    'mind/directions/trial/speech/examples/e-boris-54.md',
    { id: 'e-boris-54', type: 'example', scope: 'trial', title: 'Посмотрел видео', topic: 'other' },
    '## Клиент\n\n(Прислал ссылку на видео)\n\n## Борис\n\nПосмотрел ваше видео, получилось занятно. Возник вопрос, а как вы считаете рост?',
  )
  await putRecord(
    root,
    'mind/directions/trial/speech/examples/e-boris-56.md',
    { id: 'e-boris-56', type: 'example', scope: 'trial', title: 'Куда идти', topic: 'process' },
    '## Клиент\n\nкуда идти\n\n## Борис\n\nБуквально пара минут и сориентирую',
  )
  await ensureMindIndex(db, root)
}

describe("Boris's voice in a bid, on test orders first (10.11.2026)", () => {
  it('FR-LEAD-6: a real order gets no voice while conv.voice is «test»', async () => {
    await voiceMind()
    expect(await bidVoiceFor(db, mind, REAL)).toBeNull()
    expect(await bidVoiceFor(db, mind, null)).toBeNull()
  })

  it('FR-LEAD-6: a test order reads the portrait, the form of the text, the voice rules, the first-touch samples and the banned phrases', async () => {
    await voiceMind()
    const v = await bidVoiceFor(db, mind, TEST)
    expect(v?.records.map((r) => r.id)).toEqual(['s-portrait', 'j-tone', 'j-voice'])
    // Only the samples chosen for a first touch, in their order; a sample of a chat in full swing is not one.
    expect(v?.samples.map((s) => s.id)).toEqual(['e-boris-52', 'e-boris-54'])
    expect(BID_VOICE_SAMPLES).not.toContain('e-boris-56')
    expect(v?.banned).toEqual(['По опыту', 'Как вам такое'])
  })

  it('FR-LEAD-6: after conv.voice = «all» a real order gets the voice too', async () => {
    await voiceMind()
    await setSetting(db, 'conv.voice', 'all', 'boris')
    expect((await bidVoiceFor(db, mind, REAL))?.records.map((r) => r.id)).toEqual([
      's-portrait',
      'j-tone',
      'j-voice',
    ])
  })

  it('FR-LEAD-6: a mind without the voice, or no mind, leaves the bid as it was', async () => {
    expect(await bidVoiceFor(db, mind, TEST)).toBeNull()
    expect(await bidVoiceFor(db, undefined, TEST)).toBeNull()
  })

  it('FR-LEAD-6: a mind that cannot give its banned phrases still gives the voice, with none banned', async () => {
    await voiceMind()
    const v = await bidVoiceFor(db, { byIds: (ids) => mind.byIds(ids) }, TEST)
    expect(v?.records.map((r) => r.id)).toEqual(['s-portrait', 'j-tone', 'j-voice'])
    expect(v?.banned).toEqual([])
  })
})

describe('the voice section the Analyst reads', () => {
  const voice = async (): Promise<BidVoice> => {
    await voiceMind()
    const v = await bidVoiceFor(db, mind, TEST)
    if (!v) throw new Error('no voice')
    return v
  }

  it("FR-LEAD-6: a bid is a first touch, the skill's «строже»: full sentences, almost no slang, the greeting stays the program's", async () => {
    const text = bidVoiceText(await voice())
    expect(text).toMatch(/^Голос Бориса/)
    expect(text).toContain('первое касание')
    expect(text).toContain('«строже»')
    expect(text).toContain('полные предложения')
    expect(text).toContain('сленга почти нет')
    expect(text).toMatch(/[Пп]риветствие[^\n]*программа/)
    // The series is written by the same call and in the same voice.
    expect(text).toMatch(/[Сс]ери[яю][^\n]*голос/)
    // The rules of the role on the form of a bid stay: the open decisions 3 and 4 are not the skill's to change.
    expect(text).toMatch(/без дефисов[^\n]*без точки в конце абзаца/)
    expect(text).not.toContain(DASH)
  })

  it('FR-LEAD-6: it holds the records whole, the samples as client and Boris, and the phrases he never says', async () => {
    const text = bidVoiceText(await voice())
    expect(text).toContain('[s-portrait] Портрет речи Бориса\n## Режим: строже или свободнее')
    expect(text).toContain('[j-tone] Тон и форма текста')
    expect(text).toContain('[j-voice] Голос Бориса\n## Правило: кавычки')
    expect(text).toContain(
      '[e-boris-52]\nКлиент: (Обещал посмотреть разбор и пропал)\nБорис: Добрый день, [имя 1]!\nПишу насчет разбора\nПометка: Строгий режим.',
    )
    expect(text).toContain(
      '[e-boris-54]\nКлиент: (Прислал ссылку на видео)\nБорис: Посмотрел ваше видео',
    )
    // The samples are chats, not bids: the tone is taken from them, never their facts.
    expect(text).toMatch(/[Оо]бразцы[^\n]*не отклики/)
    expect(text).toContain('Никогда не пиши: «По опыту», «Как вам такое»')
  })

  it('FR-LEAD-6: with nothing banned the section has no line of banned phrases', async () => {
    const v = await voice()
    expect(bidVoiceText({ ...v, banned: [] })).not.toContain('Никогда не пиши')
  })
})

describe('a phrase Boris never says, in a bid', () => {
  it('FR-LEAD-6: found whatever the case, «ё» and the marks around it; null when there is none', () => {
    const banned = ['По опыту', 'Как вам такое']
    expect(bannedIn(['Скажу так: по опыту, это долго'], banned)).toBe('По опыту')
    expect(bannedIn(['Понял задачу', 'КАК ВАМ ТАКОЕ?'], banned)).toBe('Как вам такое')
    expect(bannedIn(['Сделаем быстро)'], ['Ещё бы'])).toBeNull()
    expect(bannedIn(['Еще бы)'], ['Ещё бы'])).toBe('Ещё бы')
    // Whole words only: «попытку» holds no «по».
    expect(bannedIn(['Сделаем попытку'], ['по'])).toBeNull()
    expect(bannedIn(['Понял задачу'], [])).toBeNull()
  })
})
