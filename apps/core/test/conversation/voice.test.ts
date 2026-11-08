import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { scopesOf, voiceOn, withoutTrial } from '../../src/conversation/voice'
import { ensureMindIndex } from '../../src/mind/indexer'
import { createMindSearch } from '../../src/mind/search'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'
import { putRecord, tempMind } from '../helpers/mind'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const DIR = 'hance-marketing'
const mind = createMindSearch(db)

/** A mind with a shared tone, a trial portrait, a trial rule and a trial sample of Boris's voice. */
async function voiceMind(): Promise<void> {
  const root = await tempMind()
  await putRecord(
    root,
    'mind/shared/judgment/tone.md',
    { id: 'j-tone', type: 'judgment', title: 'Тон', tags: ['тон'] },
    '## Правило: тон\nТёплый и деловой.',
  )
  await putRecord(
    root,
    'mind/directions/trial/speech/portrait.md',
    { id: 's-portrait', type: 'speech', scope: 'trial', title: 'Портрет речи Бориса' },
    '## Режим\nСтроже или свободнее.\n\n## Никогда не говорит\n- По опыту\n- Как вам такое',
  )
  await putRecord(
    root,
    'mind/directions/trial/judgment/voice.md',
    { id: 'j-voice', type: 'judgment', scope: 'trial', title: 'Голос Бориса', tags: ['голос'] },
    '## Правило: кавычки\nБез ёлочек.',
  )
  await putRecord(
    root,
    'mind/directions/trial/speech/examples/e-boris-50.md',
    { id: 'e-boris-50', type: 'example', scope: 'trial', title: 'Прислали файл', topic: 'process' },
    '## Клиент\n\nПрислал заполненный файл\n\n## Борис\n\nБлагодарю, файл я изучу и напишу',
  )
  await ensureMindIndex(db, root)
}

describe("Boris's new voice on test orders first (07.11.2026)", () => {
  it('a real conversation does not see the trial records, a test one sees them with the shared ones', async () => {
    await voiceMind()
    const real = await mind.search({
      text: 'Прислал заполненный файл',
      scope: scopesOf(DIR, false),
      types: ['example'],
      limit: 5,
      field: 'example_client',
    })
    expect(real).toEqual([])
    const test = await mind.search({
      text: 'Прислал заполненный файл',
      scope: scopesOf(DIR, true),
      types: ['example'],
      limit: 5,
      field: 'example_client',
    })
    expect(test.map((h) => h.id)).toEqual(['e-boris-50'])
    const always = await mind.byIds(['j-tone', 's-portrait', 'j-voice'])
    expect(withoutTrial(always, false).map((h) => h.id)).toEqual(['j-tone'])
    expect(withoutTrial(always, true).map((h) => h.id)).toEqual(['j-tone', 's-portrait', 'j-voice'])
  })

  it("a stage's rule is found with the trial scope too, the direction's own first (08.11.2026: the list broke the order)", async () => {
    const root = await tempMind()
    await putRecord(
      root,
      'mind/shared/judgment/talking.md',
      { id: 'j-talking', type: 'judgment', title: 'Разговор', stages: ['talking'] },
      '## Правило: разговор\nОбщее.',
    )
    await putRecord(
      root,
      `mind/directions/${DIR}/judgment/talking.md`,
      {
        id: 'j-talking-hance',
        type: 'judgment',
        scope: DIR,
        title: 'Разговор Hance',
        stages: ['talking'],
      },
      '## Правило: разговор\nСвоё.',
    )
    await ensureMindIndex(db, root)
    expect((await mind.byStage('talking', scopesOf(DIR, true)))?.id).toBe('j-talking-hance')
    expect((await mind.byStage('talking', scopesOf(DIR, false)))?.id).toBe('j-talking-hance')
    expect((await mind.byStage('talking', scopesOf('other', true)))?.id).toBe('j-talking')
  })

  it('the trial portrait bans its phrases only where the new voice is on', async () => {
    await voiceMind()
    expect(await mind.bannedPhrases()).toEqual([])
    expect(await mind.bannedPhrases({ trial: true })).toEqual(['По опыту', 'Как вам такое'])
  })

  it('the voice is on for a test order, and for every order after «all»', async () => {
    expect(await voiceOn(db, '99000000001')).toBe(true)
    expect(await voiceOn(db, '95812257')).toBe(false)
    expect(await voiceOn(db, null)).toBe(false)
    await setSetting(db, 'conv.voice', 'all', 'boris')
    expect(await voiceOn(db, '95812257')).toBe(true)
  })
})
