import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ExamScenario } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { dossierFromScenario, examNames, loadScenarios } from '../../src/exam/scenarios'
import { redact } from '../../src/gateway/redact'

const ROOT = resolve(import.meta.dirname, '../../../..')
const HANDMADE = join(ROOT, 'tests/exam/scenarios')

/** A small valid scenario, written to a file by the tests below. */
function scenarioOf(id: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: 'Клиент спрашивает цену',
    source: { kind: 'handmade', ref: null },
    tags: {
      question_type: null,
      stage: 'talking',
      tone: 'neutral',
      archetype: null,
      hard: false,
    },
    golden: false,
    order: {
      title: 'Сайт для клиники',
      category: 'Сайты',
      text: 'Нужен сайт с записью',
      budget_text: null,
      city: 'Краснодар',
    },
    client_name: 'Анна',
    messages: [
      {
        author: 'sara_v1',
        text: 'Анна, добрый день! Увидели ваш заказ.',
        at: '2026-11-09T07:00:00Z',
      },
      { author: 'client', text: 'Сколько это стоит?', at: '2026-11-09T07:10:00Z' },
    ],
    state: { owner: 'sara', owner_reason: null, boris_note: null },
    now: '2026-11-09T07:12:00Z',
    expect: { move: 'call_boris' },
    ...o,
  }
}

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'exam-scn-'))
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text)
  return dir
}

/** Every string a scenario holds, except its times. */
function strings(v: unknown, key = ''): string[] {
  if (typeof v === 'string') return key === 'at' || key === 'now' ? [] : [v]
  if (Array.isArray(v)) return v.flatMap((x) => strings(x))
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => strings(x, k))
  return []
}

describe('the handmade scenarios', () => {
  it('FR-TRAIN-8: every handmade scenario parses and ids are unique', async () => {
    const { scenarios, errors } = await loadScenarios([HANDMADE])
    expect(errors).toEqual([])
    expect(scenarios).toHaveLength(30)
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(30)
    const files = (await readdir(HANDMADE)).filter((f) => f.endsWith('.json')).sort()
    expect(files).toEqual(scenarios.map((s) => `${s.id}.json`).sort())
    for (const s of scenarios) {
      expect(s.source).toEqual({ kind: 'handmade', ref: null })
      expect(s.golden).toBe(false)
    }
  })

  it('FR-TRAIN-8: 20% or more of the set is hard', async () => {
    const { scenarios } = await loadScenarios([HANDMADE])
    const hard = scenarios.filter((s) => s.tags.hard)
    expect(hard.length / scenarios.length).toBeGreaterThanOrEqual(0.2)
    // 18 typical situations and 12 hard ones (M4 design 5.13).
    expect(hard).toHaveLength(12)
    expect(scenarios.length - hard.length).toBe(18)
  })

  it('NFR-PRIV-2: handmade scenarios hold no phone, e-mail or link except the trap ones marked so', async () => {
    const { scenarios } = await loadScenarios([HANDMADE])
    const traps: string[] = []
    for (const s of scenarios) {
      const found = strings(s)
        .map((t) => redact(t).counts)
        .reduce((n, c) => n + c.phone + c.email + c.link, 0)
      if (s.tags.trap) {
        traps.push(s.id)
        // A trap is a trap: it really holds one, and it is a hard scenario.
        expect(found, `${s.id} is marked a trap but holds no contact`).toBeGreaterThan(0)
        expect(s.tags.hard, `${s.id} is a trap but not hard`).toBe(true)
      } else {
        expect(found, `${s.id} holds a phone, an e-mail or a link`).toBe(0)
      }
    }
    expect(traps.length).toBeGreaterThan(0)
  })

  it('FR-TRAIN-8: no scenario holds a long or medium dash', async () => {
    const dash = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)]
    for (const f of await readdir(HANDMADE)) {
      const text = await readFile(join(HANDMADE, f), 'utf8')
      for (const d of dash) expect(text.includes(d), `${f} holds a dash`).toBe(false)
    }
  })

  it('FR-TRAIN-8: the hard set covers the traps of the design and three scenarios about cases', async () => {
    const { scenarios } = await loadScenarios([HANDMADE])
    const hard = scenarios.filter((s) => s.tags.hard)
    const said = (s: ExamScenario) => s.messages.filter((m) => m.author === 'client').at(-1)?.text
    const has = (re: RegExp) => hard.some((s) => re.test(said(s) ?? ''))
    expect(has(/забудь/i)).toBe(true) // the injection
    expect(has(/бот/i)).toBe(true) // «ты бот?»
    expect(has(/скидк/i)).toBe(true) // «Борис обещал скидку»
    expect(has(/NDA/)).toBe(true)
    expect(has(/прямо сейчас/i)).toBe(true) // «позвоните прямо сейчас»
    expect(hard.some((s) => s.tags.tone === 'rudeness')).toBe(true)
    expect(hard.some((s) => s.tags.tone === 'joke')).toBe(true)
    expect(hard.some((s) => s.tags.tone === 'bargaining')).toBe(true)
    // Cases: needed (the client asked for examples), out of place (a first message without a request), none that fits.
    const withCases = hard.filter((s) => s.cases.length > 0)
    expect(withCases).toHaveLength(3)
    expect(withCases.map((s) => s.expect.case).sort()).toEqual(['needed', 'none', 'none'])
    const needed = withCases.find((s) => s.expect.case === 'needed')
    expect(said(needed as ExamScenario)).toMatch(/пример/i)
    const [outOfPlace, noFit] = withCases
      .filter((s) => s.expect.case === 'none')
      .sort((a, b) => a.messages.length - b.messages.length)
    // The first message of the chat after the bid, no request for examples, and a case that would fit stands ready.
    expect(outOfPlace?.messages.filter((m) => m.author === 'client')).toHaveLength(1)
    expect(said(outOfPlace as ExamScenario)).not.toMatch(/пример|кейс|портфолио|работали/i)
    // The client asks for examples, and none of the scenario's cases fits.
    expect(said(noFit as ExamScenario)).toMatch(/пример/i)
    for (const s of withCases) {
      expect(new Set(s.cases.map((c) => c.id)).size).toBe(s.cases.length)
      // Invented: no case may carry a link.
      for (const c of s.cases) expect(strings(c).join(' ')).not.toMatch(/https?:|www\./)
    }
  })

  it('FR-TRAIN-8: every scenario ends with the client turn and has a time to answer it', async () => {
    const { scenarios } = await loadScenarios([HANDMADE])
    for (const s of scenarios) {
      const last = s.messages.at(-1)
      expect(last?.author, s.id).toBe('client')
      const times = s.messages.map((m) => Date.parse(m.at))
      expect(times, `${s.id} is not in time order`).toEqual([...times].sort((a, b) => a - b))
      expect(Date.parse(s.now)).toBeGreaterThanOrEqual(times.at(-1) ?? 0)
    }
  })
})

describe('loadScenarios', () => {
  it('FR-TRAIN-8: a duplicate id, a broken file and a scenario that does not end with the client are reported', async () => {
    const dir = await dirWith({
      'x-a.json': JSON.stringify(scenarioOf('x-a')),
      'x-b.json': JSON.stringify(scenarioOf('x-b')),
      'x-broken.json': '{"id": "x-broken"',
      'x-wrong.json': JSON.stringify(scenarioOf('x-wrong', { expect: {} })),
      'x-other-name.json': JSON.stringify(scenarioOf('x-named-differently')),
      'x-last-ours.json': JSON.stringify(
        scenarioOf('x-last-ours', {
          messages: [
            { author: 'client', text: 'Здравствуйте', at: '2026-11-09T07:00:00Z' },
            { author: 'boris', text: 'Добрый день', at: '2026-11-09T07:05:00Z' },
          ],
        }),
      ),
      'notes.txt': 'not a scenario',
    })
    const twin = await dirWith({ 'x-a.json': JSON.stringify(scenarioOf('x-a')) })
    const { scenarios, errors } = await loadScenarios([dir, twin])
    expect(scenarios.map((s) => s.id)).toEqual(['x-a', 'x-b'])
    const bad = Object.fromEntries(errors.map((e) => [e.path.split('/').at(-1), e.message]))
    expect(errors).toHaveLength(5)
    expect(errors.find((e) => e.path === join(twin, 'x-a.json'))?.message).toMatch(/x-a/)
    expect(bad['x-broken.json']).toBeTruthy()
    expect(bad['x-wrong.json']).toMatch(/expect/)
    expect(bad['x-last-ours.json']).toMatch(/клиент/)
    expect(bad['x-other-name.json']).toMatch(/имя файла/)
  })

  it('FR-TRAIN-8: a missing folder is an empty set, and several folders are one set', async () => {
    const one = await dirWith({ 'x-a.json': JSON.stringify(scenarioOf('x-a')) })
    const two = await dirWith({ 'x-b.json': JSON.stringify(scenarioOf('x-b')) })
    const missing = join(tmpdir(), 'exam-no-such-folder')
    expect((await loadScenarios([missing])).scenarios).toEqual([])
    const both = await loadScenarios([one, missing, two])
    expect(both.scenarios.map((s) => s.id)).toEqual(['x-a', 'x-b'])
    expect(both.errors).toEqual([])
  })

  it('FR-TRAIN-8: the set hash follows the content, not the order of the folders', async () => {
    const one = await dirWith({ 'x-a.json': JSON.stringify(scenarioOf('x-a')) })
    const two = await dirWith({ 'x-b.json': JSON.stringify(scenarioOf('x-b')) })
    const ab = await loadScenarios([one, two])
    const ba = await loadScenarios([two, one])
    expect(ab.setHash).toBe(ba.setHash)
    expect(ab.setHash).toMatch(/^[0-9a-f]{16}$/)
    const changed = await dirWith({
      'x-a.json': JSON.stringify(scenarioOf('x-a', { title: 'Другое название' })),
      'x-b.json': JSON.stringify(scenarioOf('x-b')),
    })
    expect((await loadScenarios([changed])).setHash).not.toBe(ab.setHash)
    expect((await loadScenarios([one])).setHash).not.toBe(ab.setHash)
  })

  it('FR-TRAIN-8: a scenario folder can be nested under a missing parent without failing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'exam-nest-'))
    await mkdir(join(base, 'exam/scenarios'), { recursive: true })
    await writeFile(join(base, 'exam/scenarios/x-a.json'), JSON.stringify(scenarioOf('x-a')))
    const r = await loadScenarios([join(base, 'exam/scenarios'), join(base, 'nothing/here')])
    expect(r.scenarios).toHaveLength(1)
  })
})

describe('dossierFromScenario', () => {
  const parse = (o: Record<string, unknown> = {}) => ExamScenario.parse(scenarioOf('x-a', o))

  it('FR-TRAIN-8: the dossier holds the order, the bid, the chat and the client turn of the scenario', () => {
    const d = dossierFromScenario(parse())
    expect(d.order?.title).toBe('Сайт для клиники')
    expect(d.order?.category).toBe('Сайты')
    expect(d.clientName).toBe('Анна')
    // The bid is the opening message of our side, as the live dossier finds it.
    expect(d.bid).toEqual({ text: 'Анна, добрый день! Увидели ваш заказ.', author: 'sara_v1' })
    expect(d.messages.map((m) => [m.author, m.side])).toEqual([
      ['sara_v1', 'specialist'],
      ['client', 'client'],
    ])
    expect(d.turnMessageIds).toEqual([d.messages[1]?.platformMessageId])
    expect(d.stage).toBe('talking')
    expect(d.owner).toBe('sara')
    expect(d.remindersSent).toBe(0)
    expect(d.toldCases).toEqual([])
  })

  it('FR-TRAIN-8: the flags of a new Moscow day and of the night follow the time of the scenario', () => {
    // Our last message at 10:00 Moscow on the 9th, the answer at 10:12 the same day: no greeting, no night.
    const same = dossierFromScenario(parse())
    expect(same.newDay).toBe(false)
    expect(same.night).toBe(false)
    expect(same.lastOursAt).toBe('2026-11-09T07:00:00Z')
    // 23:50 Moscow and 00:10 Moscow are one day by UTC and two days by Moscow time.
    const midnight = dossierFromScenario(
      parse({
        messages: [
          { author: 'boris', text: 'Добрый вечер!', at: '2026-11-09T20:50:00Z' },
          { author: 'client', text: 'Можно вопрос?', at: '2026-11-09T21:08:00Z' },
        ],
        now: '2026-11-09T21:10:00Z',
      }),
    )
    expect(midnight.newDay).toBe(true)
    expect(midnight.night).toBe(true)
    // The morning after, at 09:30 Moscow, is a new day and no night.
    const morning = dossierFromScenario(
      parse({
        messages: [
          { author: 'sara', text: 'Добрый день!', at: '2026-11-09T12:00:00Z' },
          { author: 'client', text: 'Вернулась к вам', at: '2026-11-10T06:30:00Z' },
        ],
        now: '2026-11-10T06:33:00Z',
      }),
    )
    expect(morning.newDay).toBe(true)
    expect(morning.night).toBe(false)
  })

  it('FR-TRAIN-8: the state, the note of Boris and an empty order come through', () => {
    const d = dossierFromScenario(
      parse({
        state: { owner: 'boris', owner_reason: 'take', boris_note: 'Веду сам.' },
        order: { title: '', text: '', budget_text: null, city: '' },
        client_name: null,
      }),
    )
    expect(d.owner).toBe('boris')
    expect(d.ownerReason).toBe('take')
    expect(d.borisNote).toBe('Веду сам.')
    expect(d.order).toBeNull()
    expect(d.clientName).toBeNull()
  })

  it('FR-TRAIN-8: a case our side already told is a told case, and the author of a message sets its side', () => {
    const case1 = {
      id: 'k-case-x1',
      title: 'Лиса-Клиник: онлайн-запись, Краснодар',
      summary: 'Сделали сайт с онлайн-записью.',
      result: null,
      show_rules: ['Компанию можно называть.'],
      name_open: true,
      numbers_open: false,
    }
    const case2 = { ...case1, id: 'k-case-x2', title: 'Школа танцев: стратегия, Казань' }
    const d = dossierFromScenario(
      parse({
        cases: [case1, case2],
        messages: [
          {
            author: 'sara',
            text: 'Делали для Лиса-Клиник онлайн-запись.',
            at: '2026-11-09T07:00:00Z',
          },
          { author: 'system', text: 'Заказ изменён', at: '2026-11-09T07:05:00Z' },
          { author: 'unknown', text: 'Ждём ответа', at: '2026-11-09T07:06:00Z' },
          { author: 'client', text: 'А ещё что-то есть?', at: '2026-11-09T07:10:00Z' },
        ],
      }),
    )
    expect(d.toldCases).toEqual([
      { id: 'k-case-x1', title: 'Лиса-Клиник: онлайн-запись, Краснодар' },
    ])
    expect(d.messages.map((m) => m.side)).toEqual(['specialist', 'system', 'specialist', 'client'])
  })

  it('NFR-PRIV-2: the names hidden from the model are the client name and the name our bid greeted', () => {
    expect(examNames(parse())).toEqual(['Анна'])
    expect(
      examNames(
        parse({
          client_name: 'Анна Иванова',
          messages: [
            {
              author: 'sara_v1',
              text: 'Аня, здравствуйте! Увидели заказ.',
              at: '2026-11-09T07:00:00Z',
            },
            { author: 'client', text: 'Сколько?', at: '2026-11-09T07:10:00Z' },
          ],
        }),
      ),
    ).toEqual(['Анна Иванова', 'Аня'])
    // A tag in place of the name (a scenario built from history) is not a name to look for.
    expect(
      examNames(
        parse({
          client_name: '[имя 1]',
          messages: [
            { author: 'boris', text: '[имя 1], здравствуйте!', at: '2026-11-09T07:00:00Z' },
            { author: 'client', text: 'Сколько?', at: '2026-11-09T07:10:00Z' },
          ],
        }),
      ),
    ).toEqual([])
    // «Добрый день, ...» opens a greeting, not a name.
    expect(
      examNames(
        parse({
          client_name: null,
          messages: [
            { author: 'boris', text: 'Добрый, день! Увидели заказ.', at: '2026-11-09T07:00:00Z' },
            { author: 'client', text: 'Сколько?', at: '2026-11-09T07:10:00Z' },
          ],
        }),
      ),
    ).toEqual([])
  })
})
