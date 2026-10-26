import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type EventEnvelope, newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendTurnCard } from '../../src/conversation/cards'
import { compareAfterTurn } from '../../src/conversation/compare'
import { createConversationEvents } from '../../src/conversation/events'
import { rowOf } from '../../src/conversation/store'
import { moscowHour } from '../../src/conversation/time'
import { pokeTurn, setTurnDeps, startTurnFor, type TurnDeps } from '../../src/conversation/turn'
import { account, conversation, convTurn, event } from '../../src/db/schema'
import { createGateway } from '../../src/gateway/gateway'
import { createSecretStore } from '../../src/secrets/store'
import { setSetting } from '../../src/settings/store'
import { launchDbos, shutdownDbos } from '../../src/workflows/dbos'
import { chatMsg, fakeMind, interlocutorAnswer, stubProfi } from '../helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'
import { countEvents } from '../helpers/events'

// The real code checks come with part D; here every reply passes them, so the send path can run.
const checks = vi.hoisted(() => ({ issues: [] as { id: string; detail: string }[] }))
vi.mock('../../src/conversation/check/codeChecks', () => ({
  checkReplyText: () => checks.issues,
  isNewMoscowDay: () => false,
}))
// The Checker comes with part D too: here it read every reply and found nothing.
vi.mock('../../src/conversation/check/checkerRole', () => ({
  runCheckerRole: async () => ({ issues: [], ran: true, modelCallId: null }),
}))

const ROOT = resolve(import.meta.dirname, '../../../..')
const ACC = 'hance-marketing'
const CHAT = '95147898'
const { db, close } = openTestDb()
const profi = stubProfi([])
let cliLog = ''
let cards: string[]
let outcomes: { turnId: string; conversationId: string; outcome: string; at: string }[] = []
let forwards: string[]
let cardRetryOverride: TurnDeps['cardRetry']
let sends: { turnId: string; round: number }[]
let sendExpects: (string | null | undefined)[]
let sendAnswer: 'confirmed' | 'changed' = 'confirmed'
let pause = 200
let onCard: () => Promise<void> = async () => {}
let onSend: () => Promise<void> = async () => {}
let mindFails = false
let readsFail = false
let forwardFails = false
let realCards = false
let edits: string[] = []
const cardNotifier = {
  sendButtons: async () => ({ messageId: 700 }),
  editText: async (_id: number, text: string) => {
    edits.push(text)
  },
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turn-'))
  cliLog = join(dir, 'calls.log')
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
  for (const [name, model] of [
    ['interlocutor', 'sonnet'],
    ['checker', 'haiku'],
  ] as const) {
    await mkdir(join(dir, 'roles', name), { recursive: true })
    await writeFile(
      join(dir, 'roles', name, 'meta.json'),
      JSON.stringify({ name, version: 1, model, priority: 'P0', timeoutMs: 30000 }),
    )
    await writeFile(join(dir, 'roles', name, 'role.md'), 'Роль для теста.')
  }
  const secrets = createSecretStore(join(dir, 'data'))
  await secrets.set('claude_oauth_token', 'tok')
  const gateway = createGateway({
    db,
    secrets,
    claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: {
      FAKE_CLAUDE_ARGS_LOG: cliLog,
      FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
        interlocutor: interlocutorAnswer({
          case: { moment: 'doubt', case_id: 'k-case-01', why: 'Клиент сомневается в сроке' },
        }),
      }),
    },
  })
  const mind = fakeMind()
  const deps: TurnDeps = {
    db,
    profi: {
      ...profi,
      readChat: async (...a) => {
        if (readsFail) throw new Error('the chat page is not open')
        return profi.readChat(...a)
      },
      getOrder: async () => {
        throw new Error('not known')
      },
    },
    gateway,
    mind: {
      ...mind,
      search: async (q) => {
        if (mindFails) throw new Error('the mind index is gone')
        return mind.search(q)
      },
    },
    card: async (turnId) => {
      cards.push(turnId)
      if (realCards) await sendTurnCard({ db, notifier: cardNotifier }, turnId)
      await onCard()
    },
    compare: (turnId) => compareAfterTurn({ db, notifier: cardNotifier }, turnId),
    forward: async (turnId) => {
      forwards.push(turnId)
      if (forwardFails) throw new Error('telegram is down')
    },
    send: async (turnId, round, expectLast) => {
      sends.push({ turnId, round })
      sendExpects.push(expectLast)
      const answer = sendAnswer
      await onSend()
      return answer
    },
    pauseMs: () => pause,
    stepRetry: { maxAttempts: 2, intervalSeconds: 0.2, backoffRate: 1 },
    get cardRetry() {
      return cardRetryOverride
    },
    unreadableRetry: { tries: 2, everyMs: 100 },
    onOutcome: async (o) => {
      outcomes.push(o)
    },
  }
  setTurnDeps(deps)
  await launchDbos(testDatabaseUrl())
  // DBOS starts slowly on a loaded machine.
}, 60000)
afterAll(async () => {
  await shutdownDbos()
  await close()
})

beforeEach(async () => {
  checks.issues = []
  await resetDb(db)
  profi.chat = [
    chatMsg(
      'm-1',
      'specialist',
      'Анна, добрый день! Понимаю задачу.',
      new Date(Date.now() - 3600_000).toISOString(),
    ),
  ]
  cards = []
  outcomes = []
  forwards = []
  cardRetryOverride = undefined
  sends = []
  sendExpects = []
  sendAnswer = 'confirmed'
  pause = 200
  onCard = async () => {}
  onSend = async () => {}
  mindFails = false
  readsFail = false
  forwardFails = false
  realCards = false
  edits = []
  await setSetting(db, 'pipeline.conversations', true, 'system')
  await setSetting(db, 'conv.quiet_after_message_s', 1, 'system')
  await setSetting(db, 'conv.quiet_after_typing_s', 1, 'system')
  await setSetting(db, 'conv.max_wait_s', 20, 'system')
  // Never night in these tests: the night is an hour that starts two hours from now.
  const h = moscowHour(new Date())
  await setSetting(db, 'conv.night', { from: (h + 2) % 24, to: (h + 3) % 24 }, 'system')
})

const events = () =>
  createConversationEvents({
    db,
    profi,
    notifier: { sendText: async () => ({ messageId: 1 }) },
    onTurnNeeded: (c) => startTurnFor(c),
    onTyping: (c) => pokeTurn(c),
    onSpecialist: async () => {},
  })

function ev(type: EventEnvelope['type'], payload: Record<string, unknown>): EventEnvelope {
  return {
    id: newEventId(),
    type,
    v: 1,
    entity: { kind: 'chat', id: CHAT },
    account_id: ACC,
    actor: 'profi',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload,
  }
}

async function clientWrites(id: string, text: string) {
  profi.chat.push(chatMsg(id, 'client', text, new Date().toISOString()))
  await events()(
    ev('profi.client_message', {
      chat_id: CHAT,
      order_id: CHAT,
      platform_message_id: id,
      sent_at: new Date().toISOString(),
      author: 'client',
    }),
  )
}

/** Runs `act` while the turn waits out its human pause (the pause is long enough for the test to act). */
async function duringPause(act: () => Promise<void>) {
  pause = 2500
  const until = Date.now() + 20000
  while (Date.now() < until) {
    const [t] = await db.select().from(convTurn)
    if (t?.state === 'decided') break
    await sleep(30)
  }
  await act()
}

/** A turn after the switch that would send its own reply. */
async function afterTheSwitch() {
  await setSetting(db, 'conv.v1_writes', false, 'system')
  await setSetting(db, 'conv.autopilot', true, 'system')
  await setSetting(db, 'outbound.messages', true, 'system')
  await setSetting(db, 'conv.autonomy', { process: 'self' } as never, 'system')
}

/** A message from a side the node could not tell, stored by the event path before the turn reads the chat again. */
async function unknownSideWrites(id: string, text: string) {
  profi.chat.push(chatMsg(id, 'unknown', text, new Date(Date.now() + 1000).toISOString()))
  await events()(
    ev('profi.specialist_message', {
      chat_id: CHAT,
      order_id: CHAT,
      platform_message_id: id,
      sent_at: new Date().toISOString(),
      author: 'unknown',
    }),
  )
}

async function turnsDone(n: number, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const rows = await db.select().from(convTurn)
    if (rows.filter((r) => r.finishedAt !== null).length >= n) return rows
    await sleep(100)
  }
  return db.select().from(convTurn)
}

describe('the turn workflow', () => {
  it('FR-CONV-7: typing for a client message no turn waits on wakes nothing and fails nothing', async () => {
    // Conversations off: the message is stored, no turn starts; then the client types.
    await setSetting(db, 'pipeline.conversations', false, 'system')
    await clientWrites('m-2', 'Как начнём?')
    const [c] = await db.select().from(conversation)
    expect(c).toBeDefined()
    await expect(pokeTurn(c as never)).resolves.toBeUndefined()
    expect(await db.select().from(convTurn)).toHaveLength(0)
  }, 30000)

  it('FR-CONV-3: the turn trace keeps the case, its moment, why it was chosen and its title', async () => {
    await clientWrites('m-2', 'Вы делали что-то похожее для клиник?')
    const [turn] = await turnsDone(1)
    expect(turn?.understanding).toMatchObject({
      topic: 'process',
      case: {
        moment: 'doubt',
        case_id: 'k-case-01',
        why: 'Клиент сомневается в сроке',
        title: 'Лиса-Клиник: онлайн-запись, Краснодар',
      },
    })
    // In shadow the draft never went to the client: the next turn is offered the case again.
    expect(turn?.outcome).toBe('drafted')
    await clientWrites('m-3', 'А ещё примеры есть?')
    const next = (await turnsDone(2)).find((t) => t.id !== turn?.id)
    expect((next?.recalled as { cases?: string[] } | null)?.cases).toContain('k-case-01')
  }, 40000)

  it('FR-CONV-3: a case the client heard in a sent reply is not offered again', async () => {
    await afterTheSwitch()
    await clientWrites('m-2', 'Вы делали что-то похожее для клиник?')
    const [turn] = await turnsDone(1)
    expect(turn?.outcome).toBe('sent')
    await clientWrites('m-3', 'А ещё примеры есть?')
    const next = (await turnsDone(2)).find((t) => t.id !== turn?.id)
    expect((next?.recalled as { cases?: string[] } | null)?.cases).not.toContain('k-case-01')
    expect((next?.recalled as { cases?: string[] } | null)?.cases).toContain('k-case-02')
  }, 40000)

  it('FR-CONV-3: a case id the checks rejected is not in the trace, so the card shows no case', async () => {
    checks.issues = [{ id: 'case.unknown', detail: 'кейс k-case-01 не из кейсов этого хода' }]
    await clientWrites('m-2', 'Вы делали что-то похожее для клиник?')
    const [turn] = await turnsDone(1)
    // The answer still names the case (the fake model says it twice), the checks refuse it, the draft goes to Boris.
    expect(turn?.checks).toMatchObject({ issues: [{ id: 'case.unknown' }] })
    expect((turn?.understanding as { case?: unknown } | null)?.case).toBeNull()
    expect(turn?.decision).toBe('draft')
  }, 40000)

  it('FR-CONV-7: three client messages with typing between them get one reply', async () => {
    await clientWrites('m-2', 'Здравствуйте')
    await sleep(300)
    await events()(ev('profi.client_typing', { chat_id: CHAT, at: new Date().toISOString() }))
    await clientWrites('m-3', 'Как начнём?')
    await sleep(300)
    await events()(ev('profi.client_typing', { chat_id: CHAT, at: new Date().toISOString() }))
    await clientWrites('m-4', 'И по срокам')
    const rows = await turnsDone(1)
    await sleep(1500)
    expect(await db.select().from(convTurn)).toHaveLength(1)
    expect(rows[0]?.messageIds).toEqual(['m-2', 'm-3', 'm-4'])
    expect(cards).toHaveLength(1)
  }, 30000)

  it('FR-CONV-3: a turn leaves a trace of all 8 steps', async () => {
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t).toMatchObject({
      mindVersion: 'mind-v1',
      move: 'reply',
      factIds: ['k-process-start'],
      decision: 'draft',
      outcome: 'drafted',
      state: 'finished',
    })
    expect(Object.keys(t?.timings as object)).toEqual(
      expect.arrayContaining(['heard', 'recalled', 'planned', 'decided', 'finished']),
    )
    expect((t?.recalled as { knowledge: string[] } | undefined)?.knowledge).toEqual([
      'k-process-start',
    ])
    expect(await countEvents(db, 'conv.turn_drafted')).toBe(1)
  }, 30000)

  it('FR-CONV-7: the turn is journaled as started when the wait for the client ends, and tells its outcome', async () => {
    await clientWrites('m-2', 'Как начнём?')
    const heardAt = Date.now()
    await turnsDone(1)
    const [started] = await db.select().from(event).where(eq(event.type, 'conv.turn_started'))
    // The quiet after the client's message is 1 second here.
    expect(Date.parse(started?.occurredAt ?? '')).toBeGreaterThanOrEqual(heardAt + 900)
    expect(await countEvents(db, 'conv.turn_started')).toBe(1)
    // The outcome step runs right after the handoff marks the turn finished.
    for (let i = 0; i < 50 && outcomes.length === 0; i++) await sleep(100)
    expect(outcomes.map((o) => o.outcome)).toEqual(['drafted'])
  }, 30000)

  it('FR-CONV-5: shadow never calls send_message', async () => {
    for (const id of ['m-2', 'm-3']) {
      await clientWrites(id, `Вопрос ${id}`)
      await turnsDone(id === 'm-2' ? 1 : 2)
    }
    expect(sends).toHaveLength(0)
  }, 30000)

  it('FR-CONV-6: a specialist message during the turn cancels it after the switch', async () => {
    await setSetting(db, 'conv.v1_writes', false, 'system')
    await clientWrites('m-2', 'Как начнём?')
    profi.chat.push(
      chatMsg('m-3', 'specialist', 'Анна, наберу вас сейчас', new Date().toISOString()),
    )
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('answered')
    expect(cards).toHaveLength(0)
    const [c] = await db.select().from(conversation)
    expect(c?.owner).toBe('boris')
  }, 30000)

  it('FR-CONV-6: in shadow our side answering during the turn does not cancel it: the card goes out and gets the real reply', async () => {
    realCards = true
    await clientWrites('m-2', 'Как начнём?')
    profi.chat.push(
      chatMsg('m-3', 'specialist', 'Анна, давайте начнём с созвона', new Date().toISOString()),
    )
    await turnsDone(1)
    // The comparison is the step after the outcome: it is waited for.
    for (let i = 0; i < 100 && edits.length === 0; i++) await sleep(100)
    const [t] = await db.select().from(convTurn)
    expect(t).toMatchObject({
      outcome: 'drafted',
      messageIds: ['m-2'],
      actualMessageId: 'm-3',
      actualAuthor: 'unknown',
    })
    expect(t?.similarity).not.toBeNull()
    expect(cards).toHaveLength(1)
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatch(/Ушло клиенту/)
    expect(await countEvents(db, 'conv.compared')).toBe(1)
    expect(await countEvents(db, 'conv.turn_cancelled')).toBe(0)
    const [c] = await db.select().from(conversation)
    expect(c).toMatchObject({ owner: 'sara', handledThrough: 'm-2' })
    // What the client wrote after the real reply is a turn of its own.
    await clientWrites('m-4', 'Хорошо, завтра')
    const rows = await turnsDone(2)
    expect(rows.find((r) => r.anchorMessageId === 'm-4')?.messageIds).toEqual(['m-4'])
  }, 40000)

  it('FR-CONV-6: the client writing during the pause makes the turn plan again with the whole turn', async () => {
    await afterTheSwitch()
    let once = true
    onSend = async () => {}
    await clientWrites('m-2', 'Как начнём?')
    // The pause is 200 ms here: the client writes inside it.
    await sleep(1300)
    if (once) {
      once = false
      profi.chat.push(chatMsg('m-3', 'client', 'И сколько это займёт?', new Date().toISOString()))
    }
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('sent')
    expect(t?.messageIds).toEqual(['m-2', 'm-3'])
    expect(sends).toHaveLength(1)
  }, 30000)

  it('FR-CONV-6: the service refusing a changed chat makes the turn plan again', async () => {
    await afterTheSwitch()
    sendAnswer = 'changed'
    onSend = async () => {
      sendAnswer = 'confirmed'
    }
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('sent')
    expect(sends.map((s) => s.round)).toEqual([1, 2])
  }, 30000)

  it('FR-CONV-7: a message that comes after the turn decided starts the next turn itself', async () => {
    // The card is slow: the client writes while it goes out, after the running turn has already planned.
    onCard = async () => {
      onCard = async () => {}
      await sleep(1500)
    }
    await clientWrites('m-2', 'Как начнём?')
    const until = Date.now() + 20000
    while (Date.now() < until) {
      const [t] = await db.select().from(convTurn)
      if (t?.state === 'decided') break
      await sleep(50)
    }
    await clientWrites('m-3', 'Ещё вопрос')
    const rows = await turnsDone(2)
    expect(rows.map((r) => r.messageIds)).toEqual(expect.arrayContaining([['m-2'], ['m-3']]))
    expect(cards).toHaveLength(2)
  }, 30000)

  it('FR-CONV-7: a client message heard with a conversation row read before the handoff still starts the next turn', async () => {
    await clientWrites('m-2', 'Как начнём?')
    await turnsDone(1)
    // The event of m-3 read its row while turn 1 was still running, so the row's mark is still empty.
    profi.chat.push(chatMsg('m-3', 'client', 'Ещё вопрос', new Date().toISOString()))
    await createConversationEvents({
      db,
      profi,
      notifier: { sendText: async () => ({ messageId: 1 }) },
      onTurnNeeded: (c) => startTurnFor({ ...c, handledThrough: null }),
      onTyping: (c) => pokeTurn(c),
      onSpecialist: async () => {},
    })(
      ev('profi.client_message', {
        chat_id: CHAT,
        order_id: CHAT,
        platform_message_id: 'm-3',
        sent_at: new Date().toISOString(),
        author: 'client',
      }),
    )
    const rows = await turnsDone(2)
    expect(rows.map((r) => r.anchorMessageId).sort()).toEqual(['m-2', 'm-3'])
  }, 40000)

  it('ADR-016: the name of a chat old Sara began reaches the model as a tag, taken from her greeting', async () => {
    // No lead and no order page: the only place the name is written is the greeting of our first message.
    await clientWrites('m-2', 'Анна на связи, как начнём?')
    await turnsDone(1)
    const log = await readFile(cliLog, 'utf8')
    expect(log).toContain('[имя 1]')
    expect(log).not.toContain('Анна')
  }, 30000)

  it('FR-CONV-2: a message of an unknown side stored before the turn reads the chat still stops the turn', async () => {
    await afterTheSwitch()
    const at = Date.now()
    profi.chat.push(chatMsg('m-2', 'client', 'Как начнём?', new Date(at).toISOString()))
    await unknownSideWrites('m-3', 'что-то странное')
    const [c] = await db.select().from(conversation)
    await startTurnFor(rowOf(c as never))
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('unclear')
    expect(cards).toHaveLength(0)
    expect(sends).toHaveLength(0)
  }, 30000)

  it('FR-CONV-2: a message of an unknown side during the pause stops the turn before it sends', async () => {
    await afterTheSwitch()
    await clientWrites('m-2', 'Как начнём?')
    await duringPause(() => unknownSideWrites('m-3', 'что-то странное'))
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('unclear')
    expect(sends).toHaveLength(0)
  }, 40000)

  it('FR-CONV-11: «Закрыть» pressed during the pause stops the turn: the client’s words go to Boris', async () => {
    await afterTheSwitch()
    await clientWrites('m-2', 'Как начнём?')
    await duringPause(async () => {
      await db.update(conversation).set({ closedAt: new Date().toISOString() })
    })
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('closed')
    expect(forwards).toHaveLength(1)
    expect(sends).toHaveLength(0)
    expect(cards).toHaveLength(0)
  }, 40000)

  it('FR-CONV-11: «Беру сам» pressed during the pause stops the turn: the client’s words go to Boris', async () => {
    await afterTheSwitch()
    await clientWrites('m-2', 'Как начнём?')
    await duringPause(async () => {
      await db.update(conversation).set({ owner: 'boris', ownerReason: 'take' })
    })
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('forwarded')
    expect(forwards).toHaveLength(1)
    expect(sends).toHaveLength(0)
  }, 40000)

  it('FR-OPS-1: the «Пишет клиентам» pause switched off during the pause makes the reply a draft', async () => {
    await afterTheSwitch()
    await clientWrites('m-2', 'Как начнём?')
    await duringPause(() => setSetting(db, 'outbound.messages', false, 'boris'))
    const [t] = await turnsDone(1)
    expect(t).toMatchObject({ outcome: 'drafted', decision: 'draft' })
    expect(t?.decisionReason).toBe('пауза «Пишет клиентам»')
    expect(cards).toHaveLength(1)
    expect(sends).toHaveLength(0)
  }, 40000)

  it('FR-CONV-5: with the autopilot off the reply is a draft for Boris’s press, nothing is sent', async () => {
    await afterTheSwitch()
    await setSetting(db, 'conv.autopilot', false, 'system')
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t).toMatchObject({
      outcome: 'drafted',
      decision: 'draft',
      decisionReason: 'отправлю по твоему нажатию',
    })
    expect(cards).toHaveLength(1)
    expect(sends).toHaveLength(0)
  }, 40000)

  it('FR-CONV-5: the autopilot switched off during the pause makes the reply a draft', async () => {
    await afterTheSwitch()
    await clientWrites('m-2', 'Как начнём?')
    await duringPause(() => setSetting(db, 'conv.autopilot', false, 'boris'))
    const [t] = await turnsDone(1)
    expect(t).toMatchObject({ outcome: 'drafted', decision: 'draft' })
    expect(t?.decisionReason).toBe('отправлю по твоему нажатию')
    expect(cards).toHaveLength(1)
    expect(sends).toHaveLength(0)
  }, 40000)

  it('FR-OPS-1: an account paused during the pause makes the reply a draft', async () => {
    await afterTheSwitch()
    await clientWrites('m-2', 'Как начнём?')
    await duringPause(async () => {
      await db
        .insert(account)
        .values({ id: ACC, title: 'Hance', egressIp: '203.0.113.7', paused: true })
    })
    const [t] = await turnsDone(1)
    expect(t).toMatchObject({ outcome: 'drafted', decisionReason: 'аккаунт на паузе' })
    expect(cards).toHaveLength(1)
    expect(sends).toHaveLength(0)
  }, 40000)

  it('FR-CONV-9: the send waits for the chat as the reread saw it', async () => {
    await afterTheSwitch()
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('sent')
    expect(sendExpects).toEqual(['m-2'])
  }, 30000)

  it('FR-CONV-11: a client Boris took is forwarded to him without the model', async () => {
    await clientWrites('m-0', 'Привет')
    await turnsDone(1)
    await db.update(conversation).set({ owner: 'boris', ownerReason: 'take' })
    await clientWrites('m-2', 'Как начнём?')
    const rows = await turnsDone(2)
    expect(rows.find((r) => r.anchorMessageId === 'm-2')?.outcome).toBe('forwarded')
    expect(forwards).toHaveLength(1)
  }, 30000)

  it('FR-CONV-7: a turn that failed to plan still covers the client turn, so the next message gets its own turn', async () => {
    mindFails = true
    await clientWrites('m-2', 'Как начнём?')
    const [first] = await turnsDone(1)
    expect(first).toMatchObject({
      decisionReason: 'не смогла подготовить ответ',
      outcome: 'drafted',
    })
    expect((await db.select().from(conversation))[0]?.handledThrough).toBe('m-2')
    mindFails = false
    await clientWrites('m-3', 'Ещё вопрос')
    const rows = await turnsDone(2)
    expect(rows.map((r) => r.anchorMessageId).sort()).toEqual(['m-2', 'm-3'])
    expect(rows.find((r) => r.anchorMessageId === 'm-3')).toMatchObject({
      outcome: 'drafted',
      decision: 'draft',
    })
    expect(cards).toHaveLength(2)
  }, 40000)

  it('FR-CONV-7: a card that cannot be sent ends the turn as failed and the conversation goes on', async () => {
    onCard = async () => {
      throw new Error('telegram is down')
    }
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('failed')
    expect(await countEvents(db, 'conv.turn_failed')).toBe(1)
    expect((await db.select().from(conversation))[0]?.handledThrough).toBe('m-2')
    onCard = async () => {}
    await clientWrites('m-3', 'Ещё вопрос')
    const rows = await turnsDone(2)
    expect(rows.find((r) => r.anchorMessageId === 'm-3')?.outcome).toBe('drafted')
  }, 40000)

  it('FR-CONV-7: after the switch a card Telegram does not take at once is tried again, and the turn is still drafted', async () => {
    await afterTheSwitch()
    await setSetting(db, 'conv.autopilot', false, 'system')
    cardRetryOverride = { tries: 3, everyMs: 150 }
    let calls = 0
    onCard = async () => {
      // The first try (two calls of its step) fails, the second try goes through.
      if (++calls <= 2) throw new Error('telegram is down')
    }
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('drafted')
    expect(cards).toHaveLength(3)
    expect((await db.select().from(conversation))[0]?.handledThrough).toBe('m-2')
  }, 40000)

  it('FR-CONV-7: a card that never goes after the switch does not drop the client: he stays unanswered, an alert is journaled, his next message gets the turn', async () => {
    await afterTheSwitch()
    await setSetting(db, 'conv.autopilot', false, 'system')
    cardRetryOverride = { tries: 3, everyMs: 100 }
    onCard = async () => {
      throw new Error('telegram is down')
    }
    await clientWrites('m-2', 'Как начнём?')
    const [lost] = await turnsDone(1)
    expect(lost?.outcome).toBe('card_lost')
    expect(await countEvents(db, 'conv.turn_failed')).toBe(1)
    // The client's words are not marked as handled, and the journal says nobody got the card.
    expect((await db.select().from(conversation))[0]?.handledThrough).toBeNull()
    const alerts = await db.select().from(event).where(eq(event.type, 'notify.failed'))
    expect(alerts.some((a) => /карточка не дошла/.test(a.reason ?? ''))).toBe(true)
    // Telegram is back and the client writes again: a turn of its own answers both messages.
    onCard = async () => {}
    await clientWrites('m-3', 'Ещё вопрос')
    const rows = await turnsDone(2)
    const again = rows.find((r) => r.id !== lost?.id)
    expect(again?.outcome).toBe('drafted')
    expect(again?.messageIds).toEqual(['m-2', 'm-3'])
    expect((await db.select().from(conversation))[0]?.handledThrough).toBe('m-3')
  }, 60000)

  it('FR-CONV-7: in shadow a card that cannot be sent is not waited for: the turn fails at once, as before', async () => {
    cardRetryOverride = { tries: 3, everyMs: 5000 }
    onCard = async () => {
      throw new Error('telegram is down')
    }
    const started = Date.now()
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t?.outcome).toBe('failed')
    expect(Date.now() - started).toBeLessThan(9000)
  }, 40000)

  it('FR-CONV-7: a forward that cannot be sent ends the turn as failed after the handoff', async () => {
    await clientWrites('m-0', 'Привет')
    await turnsDone(1)
    await db.update(conversation).set({ owner: 'boris', ownerReason: 'take' })
    forwardFails = true
    await clientWrites('m-2', 'Как начнём?')
    const rows = await turnsDone(2)
    expect(rows.find((r) => r.anchorMessageId === 'm-2')?.outcome).toBe('failed')
    expect((await db.select().from(conversation))[0]?.handledThrough).toBe('m-2')
  }, 40000)

  it('FR-CONV-2: a chat that stays unreadable ends the turn with a card for Boris', async () => {
    readsFail = true
    await clientWrites('m-2', 'Как начнём?')
    const [t] = await turnsDone(1)
    expect(t).toMatchObject({
      outcome: 'failed',
      decision: 'draft',
      decisionReason: 'не могу прочитать чат',
      messageIds: ['m-2'],
    })
    expect(cards).toHaveLength(1)
  }, 40000)
})
