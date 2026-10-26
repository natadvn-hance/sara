import { SETTINGS } from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { agreesToCallProposal, detectCallRequest } from '../../src/conversation/callDetector'
import { decide } from '../../src/conversation/policy'
import { inMoscowHours, moscowHoursEnd } from '../../src/conversation/time'
import type { Dossier, PolicySettings } from '../../src/conversation/types'
import { interlocutorAnswer } from '../helpers/conversation'

const settings = (o: Partial<PolicySettings> = {}): PolicySettings => ({
  v1Writes: false,
  autopilot: true,
  outboundMessages: true,
  accountPaused: false,
  night: { from: 23, to: 8 },
  autonomy: { ...SETTINGS['conv.autonomy'].default, process: 'self' },
  ...o,
})

const dossier = (o: Partial<Dossier> = {}): Dossier => ({
  conversationId: '0192f3c4-5b6a-7c8d-9e0f-112233445566',
  accountId: 'hance-marketing',
  scope: 'hance-marketing',
  order: null,
  clientName: 'Анна',
  clientInfo: null,
  bid: null,
  messages: [],
  turnMessageIds: ['m-2'],
  borisNote: null,
  stage: 'talking',
  owner: 'sara',
  ownerReason: null,
  newDay: false,
  night: false,
  lastOursAt: null,
  remindersSent: 0,
  ...o,
})

// 12:00 Moscow
const DAY = new Date('2026-10-20T09:00:00.000Z')
// 01:00 Moscow
const NIGHT = new Date('2026-10-20T22:00:00.000Z')

const plan = (
  o: Parameters<typeof interlocutorAnswer>[0] = {},
  issues: { id: 'dash'; detail: string }[] = [],
  checkerRan = true,
) => ({
  output: interlocutorAnswer(o),
  issues,
  attempts: 1,
  checkerRan,
})

describe('rules of a reply', () => {
  it('FR-CONV-5: in shadow every reply is a draft that says what Sara would do', () => {
    const d = decide({
      plan: plan(),
      dossier: dossier(),
      settings: settings({ v1Writes: true }),
      now: DAY,
      callRequest: false,
    })
    expect(d).toMatchObject({ action: 'draft', would: 'send' })
    const c = decide({
      plan: plan({ move: 'call_boris' }),
      dossier: dossier(),
      settings: settings({ v1Writes: true }),
      now: DAY,
      callRequest: false,
    })
    expect(c).toMatchObject({ action: 'draft', would: 'call_boris' })
  })

  it('FR-CONV-5: after the switch a topic Sara may answer herself is sent', () => {
    expect(
      decide({
        plan: plan(),
        dossier: dossier(),
        settings: settings(),
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('send')
  })

  it('FR-CONV-5: after the switch with the autopilot off a reply Sara could send is a draft for Boris’s press', () => {
    const d = decide({
      plan: plan(),
      dossier: dossier(),
      settings: settings({ autopilot: false }),
      now: DAY,
      callRequest: false,
    })
    expect(d).toMatchObject({
      action: 'draft',
      would: 'send',
      reason: 'отправлю по твоему нажатию',
      holdUntil: null,
    })
  })

  it('FR-CONV-5: with the autopilot off the night does not hold a reply, it is a draft at once', () => {
    const d = decide({
      plan: plan(),
      dossier: dossier(),
      settings: settings({ autopilot: false }),
      now: NIGHT,
      callRequest: false,
    })
    expect(d).toMatchObject({ action: 'draft', reason: 'отправлю по твоему нажатию' })
  })

  it('FR-CONV-5: the autopilot changes nothing in shadow, nor a call for Boris, a forward or silence', () => {
    const off = settings({ autopilot: false })
    const shadow = decide({
      plan: plan(),
      dossier: dossier(),
      settings: { ...off, v1Writes: true },
      now: DAY,
      callRequest: false,
    })
    expect(shadow.action).toBe('draft')
    expect(shadow.reason).toMatch(/^режим тени; сама бы: /)
    expect(
      decide({
        plan: plan({ move: 'call_boris' }),
        dossier: dossier(),
        settings: off,
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('call_boris')
    expect(
      decide({
        plan: plan({ move: 'none', text: null }),
        dossier: dossier(),
        settings: off,
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('nothing')
    expect(
      decide({
        plan: plan(),
        dossier: dossier({ owner: 'boris', ownerReason: 'take' }),
        settings: off,
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('forward')
  })

  it('FR-CONV-5: a pause keeps its own reason when the autopilot is off too', () => {
    const d = decide({
      plan: plan(),
      dossier: dossier(),
      settings: settings({ autopilot: false, outboundMessages: false }),
      now: DAY,
      callRequest: false,
    })
    expect(d).toMatchObject({ action: 'draft', reason: 'пауза «Пишет клиентам»' })
  })

  it('FR-CONV-4: a reply the Checker did not see is a draft «без Проверяющего», never sent', () => {
    const d = decide({
      plan: plan({}, [], false),
      dossier: dossier(),
      settings: settings(),
      now: DAY,
      callRequest: false,
    })
    expect(d).toMatchObject({ action: 'draft', would: 'draft' })
    expect(d.reason).toContain('без Проверяющего')
  })

  it('FR-OPS-1: the «Пишет клиентам» pause and an account pause hold Sara’s own reply as a draft', () => {
    expect(
      decide({
        plan: plan(),
        dossier: dossier(),
        settings: settings({ outboundMessages: false }),
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('draft')
    expect(
      decide({
        plan: plan(),
        dossier: dossier(),
        settings: settings({ accountPaused: true }),
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('draft')
  })

  it('FR-AUTO-2: price, contract, discount and NDA always call Boris, even if settings say self', () => {
    const all = settings({
      autonomy: {
        ...SETTINGS['conv.autonomy'].default,
        price: 'self',
        contract: 'self',
        discount: 'self',
        nda: 'self',
      } as never,
    })
    for (const topic of ['price', 'contract', 'discount', 'nda'] as const) {
      const d = decide({
        plan: plan({ topic }),
        dossier: dossier(),
        settings: all,
        now: DAY,
        callRequest: false,
      })
      expect(d).toMatchObject({ action: 'call_boris', would: 'call_boris' })
    }
  })

  it('FR-CONV-5: a topic left at draft goes to Boris as a draft', () => {
    expect(
      decide({
        plan: plan({ topic: 'timeline' }),
        dossier: dossier(),
        settings: settings(),
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('draft')
  })

  it('FR-CONV-8: at night a non-urgent reply holds until 8:00 Moscow', () => {
    const d = decide({
      plan: plan(),
      dossier: dossier(),
      settings: settings(),
      now: NIGHT,
      callRequest: false,
    })
    expect(d.action).toBe('hold')
    expect(d.holdUntil).toBe('2026-10-21T05:00:00.000Z')
  })

  it('FR-CONV-8: at night a call request still calls Boris at once', () => {
    const d = decide({
      plan: plan({ move: 'call_boris', urgent: true }),
      dossier: dossier(),
      settings: settings(),
      now: NIGHT,
      callRequest: true,
    })
    expect(d.action).toBe('call_boris')
  })

  it('FR-CONV-5: a client Boris wrote to gets a draft, a client he took gets nothing', () => {
    expect(
      decide({
        plan: plan(),
        dossier: dossier({ owner: 'boris', ownerReason: 'wrote' }),
        settings: settings(),
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('draft')
    expect(
      decide({
        plan: plan(),
        dossier: dossier({ owner: 'boris', ownerReason: 'take' }),
        settings: settings(),
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('forward')
  })

  it('FR-CONV-4: a reply failing checks becomes a draft with the reasons', () => {
    const d = decide({
      plan: plan({}, [{ id: 'dash', detail: 'длинное тире' }]),
      dossier: dossier(),
      settings: settings(),
      now: DAY,
      callRequest: false,
    })
    expect(d.action).toBe('draft')
    expect(d.reason).toContain('длинное тире')
  })

  it('FR-CONV-5: nothing to answer means nothing is sent', () => {
    expect(
      decide({
        plan: plan({ move: 'none', text: null }),
        dossier: dossier(),
        settings: settings(),
        now: DAY,
        callRequest: false,
      }).action,
    ).toBe('nothing')
  })

  it('FR-OPS-3: without the Interlocutor’s answer the turn is a draft, a call request calls Boris', () => {
    const none = { output: null, issues: [], attempts: 1, checkerRan: false }
    expect(
      decide({ plan: none, dossier: dossier(), settings: settings(), now: DAY, callRequest: false })
        .action,
    ).toBe('draft')
    expect(
      decide({ plan: none, dossier: dossier(), settings: settings(), now: DAY, callRequest: true })
        .action,
    ).toBe('call_boris')
  })
})

describe('call request', () => {
  it('FR-CONV-5: a phone or a word of a call is a call request, a budget is not', () => {
    expect(detectCallRequest('8 (918) 123-45-67')).toEqual({
      phone: '8 (918) 123-45-67',
      keyword: false,
    })
    expect(detectCallRequest('+79181234567')?.phone).toBe('+79181234567')
    expect(detectCallRequest('давайте созвонимся')).toEqual({ phone: null, keyword: true })
    expect(detectCallRequest('Позвоните мне вечером')?.keyword).toBe(true)
    expect(detectCallRequest('Сейчас удобно')).toBeNull()
    expect(detectCallRequest('бюджет 89000000')).toBeNull()
  })

  it('FR-CONV-5: «перезвоните» is a call word, and a longer number is not a phone', () => {
    expect(detectCallRequest('Перезвоните мне, пожалуйста')?.keyword).toBe(true)
    expect(detectCallRequest('можно перезвонить завтра?')?.keyword).toBe(true)
    // A number with more digits than a Russian phone holds is an order or an account number.
    expect(detectCallRequest('номер заказа 891812345678901')).toBeNull()
    expect(detectCallRequest('счёт 12348918123456789')).toBeNull()
    expect(detectCallRequest('звоните 89181234567.')?.phone).toBe('89181234567')
  })
})

describe('agreement to a call', () => {
  const proposal = 'Понимаю задачу. Удобно созвониться и обсудить детали?'

  it('FR-CONV-5: a short agreement right after our call proposal is a call request', () => {
    for (const said of [
      'Да',
      'Хорошо',
      'ок',
      'Давайте',
      'Удобно',
      'Да, удобно!',
      'Да, давайте.',
      'Хорошо, давайте созвонимся',
      'Согласна\nДа, удобно',
    ])
      expect(agreesToCallProposal(said, proposal), said).toBe(true)
  })

  it('FR-CONV-5: the same words are not a call request when our message proposed no call', () => {
    for (const said of ['Да', 'Хорошо', 'ок', 'Давайте'])
      expect(agreesToCallProposal(said, 'Лендинг делаем за 2-3 недели.'), said).toBe(false)
    expect(agreesToCallProposal('Да', null)).toBe(false)
  })

  it('FR-CONV-5: an answer with more than an agreement is left to the Interlocutor', () => {
    for (const said of [
      'Да, но сначала скажите цену',
      'Хорошо, а какой срок?',
      'Удобно в 15:00',
      'Нет',
      'Нет, давайте напишем',
      'Спасибо',
      'Подумаю',
    ])
      expect(agreesToCallProposal(said, proposal), said).toBe(false)
  })
})

describe('Moscow hours', () => {
  it('FR-CONV-8: the night runs past midnight and ends at 8:00 Moscow', () => {
    const night = { from: 23, to: 8 }
    expect(inMoscowHours(new Date('2026-10-20T20:30:00.000Z'), night)).toBe(true) // 23:30
    expect(inMoscowHours(new Date('2026-10-20T04:59:00.000Z'), night)).toBe(true) // 07:59
    expect(inMoscowHours(new Date('2026-10-20T05:00:00.000Z'), night)).toBe(false) // 08:00
    expect(inMoscowHours(DAY, night)).toBe(false)
    expect(moscowHoursEnd(new Date('2026-10-20T20:30:00.000Z'), night)?.toISOString()).toBe(
      '2026-10-21T05:00:00.000Z',
    )
    expect(moscowHoursEnd(NIGHT, night)?.toISOString()).toBe('2026-10-21T05:00:00.000Z')
    expect(moscowHoursEnd(DAY, night)).toBeNull()
  })
})
